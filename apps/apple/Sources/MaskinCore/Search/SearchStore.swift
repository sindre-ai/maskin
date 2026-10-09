import Foundation
import Observation

/// Debounced, cancellable workspace search across objects, files (server-side) and chats and
/// agents (filtered on the client over their cached lists, like the web).
@MainActor
@Observable
public final class SearchStore {
	public enum Phase: Equatable, Sendable {
		/// No query yet: the recents screen.
		case idle
		case searching
		case results
		/// The only failure that matters: nothing could be searched at all.
		case failed(String)
	}

	public static let pageSize = 25

	public private(set) var query = ""
	public var scope: SearchScope = .all {
		didSet { if scope != oldValue { objectType = nil } }
	}
	/// The type sub-chip under Objects; nil means every type.
	public var objectType: String?
	public private(set) var phase: Phase = .idle
	public private(set) var allResults: [SearchResult] = []
	public private(set) var recents: [String] = []
	/// Some sources failed while others answered, so counts may be understated.
	public private(set) var isPartial = false
	public private(set) var isOffline = false

	@ObservationIgnored private let remote: any SearchRemote
	@ObservationIgnored private let recentsStore: SearchRecents
	@ObservationIgnored private let workspaceId: @MainActor () -> String?
	@ObservationIgnored private let debounce: Duration
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var task: Task<Void, Never>?
	@ObservationIgnored private var chatsCache: [SearchResult]?
	@ObservationIgnored private var agentsCache: [SearchResult]?
	@ObservationIgnored private var flowsCache: [SearchResult]?
	/// When, and for which workspace, the directory caches were filled.
	@ObservationIgnored private var cacheStamp: (workspace: String?, at: Date)?
	@ObservationIgnored private let directoryTTL: TimeInterval
	@ObservationIgnored private let now: @MainActor () -> Date

	public init(
		remote: any SearchRemote, recents: SearchRecents = SearchRecents(),
		workspaceId: @escaping @MainActor () -> String?, debounce: Duration = .milliseconds(300),
		directoryTTL: TimeInterval = 60, now: @escaping @MainActor () -> Date = { Date() }
	) {
		self.directoryTTL = directoryTTL
		self.now = now
		self.remote = remote
		self.recentsStore = recents
		self.workspaceId = workspaceId
		self.debounce = debounce
		reloadRecents()
	}

	// MARK: Derived

	/// Results in the chosen scope, grouped in display order.
	public var sections: [SearchSection] {
		SearchGroup.displayOrder.compactMap { group in
			let rows = allResults.filter { $0.group == group && scope.includes($0, objectType: objectType) }
			return rows.isEmpty ? nil : SearchSection(group: group, results: rows)
		}
	}

	/// The sub-chips under Objects: the types the current results contain.
	public var objectTypes: [String] { SearchScope.objectTypes(in: allResults) }

	public var visibleCount: Int { sections.reduce(0) { $0 + $1.results.count } }

	public func count(in scope: SearchScope) -> Int {
		allResults.filter { scope.includes($0) }.count
	}

	// MARK: Input

	/// Called on every keystroke. Cancels the previous request, waits out the debounce, then
	/// searches. A response from a superseded query is discarded.
	public func setQuery(_ text: String) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmed != query else { return }
		query = trimmed
		generation += 1
		task?.cancel()
		guard !trimmed.isEmpty else {
			allResults = []
			isPartial = false
			phase = .idle
			task = nil
			return
		}
		phase = .searching
		let mine = generation
		task = Task { [weak self, debounce] in
			do { try await Task.sleep(for: debounce) } catch { return }
			await self?.run(trimmed, generation: mine)
		}
	}

	/// Waits for the in-flight debounced search (tests and pull-to-refresh).
	public func settle() async {
		await task?.value
	}

	/// Search key pressed: remember the query and skip any remaining debounce.
	public func commit() async {
		guard !query.isEmpty else { return }
		remember(query)
		task?.cancel()
		generation += 1
		phase = .searching
		await run(query, generation: generation)
	}

	/// A result was opened: its query is worth remembering.
	public func didOpen(_ result: SearchResult) { remember(query) }

	public func retry() async {
		guard !query.isEmpty else { return }
		generation += 1
		task?.cancel()
		phase = .searching
		await run(query, generation: generation)
	}

	// MARK: Recents

	public func reloadRecents() {
		guard let workspace = workspaceId() else { recents = []; return }
		recents = recentsStore.load(workspaceId: workspace)
	}

	public func clearRecents() {
		guard let workspace = workspaceId() else { return }
		recentsStore.clear(workspaceId: workspace)
		recents = []
	}

	public func removeRecent(_ text: String) {
		guard let workspace = workspaceId() else { return }
		recents = recentsStore.remove(text, workspaceId: workspace)
	}

	private func remember(_ text: String) {
		guard let workspace = workspaceId() else { return }
		recents = recentsStore.push(text, workspaceId: workspace)
	}

	/// Drops the cached chat and agent lists (workspace switch, or a new chat was created).
	public func invalidateDirectories() {
		chatsCache = nil
		agentsCache = nil
		flowsCache = nil
		cacheStamp = nil
	}

	/// Drops the directory caches when they belong to another workspace or are older than the TTL.
	/// Called before every search and when the screen appears.
	public func expireStaleDirectories() {
		guard let stamp = cacheStamp else { return }
		if stamp.workspace != workspaceId() || now().timeIntervalSince(stamp.at) >= directoryTTL {
			invalidateDirectories()
		}
	}

	// MARK: Searching

	private func run(_ text: String, generation mine: Int) async {
		let remote = self.remote
		let limit = Self.pageSize
		expireStaleDirectories()
		let startWorkspace = workspaceId()
		let cachedChats = chatsCache
		let cachedAgents = agentsCache
		let cachedFlows = flowsCache

		async let objects = Self.attempt { try await remote.searchObjects(query: text, limit: limit) }
		async let files = Self.attempt { try await remote.searchFiles(query: text, limit: limit) }
		async let chats = Self.attempt { if let cachedChats { return cachedChats }; return try await remote.conversations() }
		async let agents = Self.attempt { if let cachedAgents { return cachedAgents }; return try await remote.agents() }
		async let flows = Self.attempt { if let cachedFlows { return cachedFlows }; return try await remote.flows() }
		let (o, f, c, a, fl) = await (objects, files, chats, agents, flows)
		// A newer query (or a cancel) started while this one was in flight.
		guard mine == generation, !Task.isCancelled else { return }
		// The workspace changed while this was in flight: its lists belong to the old one.
		guard startWorkspace == workspaceId() else {
			invalidateDirectories()
			await run(text, generation: mine)
			return
		}

		if case .success(let list) = c { chatsCache = list }
		if case .success(let list) = a { agentsCache = list }
		if case .success(let list) = fl { flowsCache = list }
		// A fresh fetch restarts the TTL; a pure cache hit leaves the old stamp alone.
		if cachedChats == nil || cachedAgents == nil || cachedFlows == nil { cacheStamp = (startWorkspace, now()) }

		// The flow list only supplements the four searched sources: it never decides "nothing could
		// be searched", but its failure still marks the results partial.
		let outcomes = [o, f, c, a]
		let errors = outcomes.compactMap { outcome -> SearchError? in
			if case .failure(let e) = outcome { return e }
			return nil
		}
		if errors.count == outcomes.count, let first = errors.first {
			allResults = []
			isOffline = first.isOffline
			isPartial = false
			phase = .failed(first.message)
			return
		}
		isOffline = false
		if case .failure = fl { isPartial = true } else { isPartial = !errors.isEmpty }

		var merged: [SearchResult] = []
		if case .success(let list) = c { merged += Self.filter(list, text) }
		if case .success(let list) = a { merged += Self.filter(list, text) }
		// The flow list is authoritative for flows; the server's object hits fill in the rest.
		var flowIds = Set<String>()
		if case .success(let list) = fl {
			let hits = Self.filter(list, text)
			flowIds = Set(hits.map(\.entityId))
			merged += hits
		}
		if case .success(let list) = o { merged += list.filter { !flowIds.contains($0.entityId) } }
		if case .success(let list) = f { merged += list }
		allResults = merged
		phase = .results
	}

	nonisolated static func filter(_ list: [SearchResult], _ text: String) -> [SearchResult] {
		list.filter { SearchHighlight.matches(text, in: $0.searchableText) }
	}

	private nonisolated static func attempt(
		_ work: @Sendable () async throws -> [SearchResult]
	) async -> Result<[SearchResult], SearchError> {
		do { return .success(try await work()) } catch {
			return .failure((error as? SearchError) ?? RemoteFailure.searchError(error))
		}
	}
}
