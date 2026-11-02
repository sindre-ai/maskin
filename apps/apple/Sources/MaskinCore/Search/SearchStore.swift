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
	/// People and agents picked with @. Only chats that contain every one of them are listed.
	public private(set) var participants: [SearchPerson] = []
	/// Everyone the @ menu can offer; empty until the first "@" is typed.
	public private(set) var people: [SearchPerson] = []

	@ObservationIgnored private let remote: any SearchRemote
	@ObservationIgnored private let recentsStore: SearchRecents
	@ObservationIgnored private let workspaceId: @MainActor () -> String?
	@ObservationIgnored private let debounce: Duration
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var task: Task<Void, Never>?
	@ObservationIgnored private var chatsCache: [SearchResult]?
	@ObservationIgnored private var agentsCache: [SearchResult]?
	@ObservationIgnored private var flowsCache: [SearchResult]?
	@ObservationIgnored private var peopleTask: Task<Void, Never>?
	@ObservationIgnored private let currentActorId: @MainActor () -> String?
	/// When, and for which workspace, the directory caches were filled.
	@ObservationIgnored private var cacheStamp: (workspace: String?, at: Date)?
	@ObservationIgnored private let directoryTTL: TimeInterval
	@ObservationIgnored private let now: @MainActor () -> Date

	public init(
		remote: any SearchRemote, recents: SearchRecents = SearchRecents(),
		workspaceId: @escaping @MainActor () -> String?, debounce: Duration = .milliseconds(300),
		directoryTTL: TimeInterval = 60, now: @escaping @MainActor () -> Date = { Date() },
		currentActorId: @escaping @MainActor () -> String? = { nil }
	) {
		self.currentActorId = currentActorId
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

	/// The people the @ menu offers for the text typed so far. Empty when the "@" matches nobody,
	/// in which case it is searched as plain text.
	public var mentionSuggestions: [SearchPerson] {
		let others = people.filter { $0.id != currentActorId() }
		return SearchMention.suggestions(for: query, in: others, excluding: participants)
	}

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
		if trimmed.contains("@") { loadPeopleIfNeeded() }
		restart()
	}

	/// An @ suggestion was tapped: it becomes a pill and its "@word" leaves the text.
	public func pick(_ person: SearchPerson) {
		guard participants.count < SearchMention.maxPicked,
			!participants.contains(where: { $0.id == person.id })
		else { return }
		query = SearchMention.removingFragment(from: query)
		participants.append(person)
		restart()
	}

	public func removeParticipant(_ person: SearchPerson) {
		guard participants.contains(where: { $0.id == person.id }) else { return }
		participants.removeAll { $0.id == person.id }
		restart()
	}

	/// Starts a debounced search for the current text and pills, or goes back to the recents
	/// screen when there is neither.
	private func restart() {
		generation += 1
		task?.cancel()
		guard !query.isEmpty || !participants.isEmpty else {
			allResults = []
			isPartial = false
			phase = .idle
			task = nil
			return
		}
		phase = .searching
		let mine = generation
		let text = query
		task = Task { [weak self, debounce] in
			do { try await Task.sleep(for: debounce) } catch { return }
			await self?.run(text, generation: mine)
		}
	}

	private func loadPeopleIfNeeded() {
		guard peopleTask == nil else { return }
		let remote = self.remote
		let startWorkspace = workspaceId()
		peopleTask = Task { [weak self] in
			let loaded = try? await remote.people()
			guard let self, !Task.isCancelled, startWorkspace == self.workspaceId() else { return }
			if let loaded { self.people = loaded } else { self.peopleTask = nil }
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
		guard !query.isEmpty || !participants.isEmpty else { return }
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
		peopleTask?.cancel()
		peopleTask = nil
		people = []
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
		let picked = participants
		// With people picked only chats can match, so the other sources are not asked.
		let chatsOnly = !picked.isEmpty

		async let objects = Self.attempt { if chatsOnly { return [] }; return try await remote.searchObjects(query: text, limit: limit) }
		async let files = Self.attempt { if chatsOnly { return [] }; return try await remote.searchFiles(query: text, limit: limit) }
		async let chats = Self.attempt { if let cachedChats { return cachedChats }; return try await remote.conversations() }
		async let agents = Self.attempt { if chatsOnly { return [] }; if let cachedAgents { return cachedAgents }; return try await remote.agents() }
		async let flows = Self.attempt { if chatsOnly { return [] }; if let cachedFlows { return cachedFlows }; return try await remote.flows() }
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
		// A chats-only search skipped agents and flows, so their empty answers must not be cached.
		if case .success(let list) = a, !chatsOnly { agentsCache = list }
		if case .success(let list) = fl, !chatsOnly { flowsCache = list }
		// A fresh fetch restarts the TTL; a pure cache hit leaves the old stamp alone.
		if chatsOnly {
			if cacheStamp == nil { cacheStamp = (startWorkspace, now()) }
		} else if cachedChats == nil || cachedAgents == nil || cachedFlows == nil {
			cacheStamp = (startWorkspace, now())
		}

		if chatsOnly, case .failure(let error) = c {
			allResults = []
			isOffline = error.isOffline
			isPartial = false
			phase = .failed(error.message)
			return
		}

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
		if case .success(let list) = c { merged += Self.withParticipants(Self.filter(list, text), picked) }
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
		allResults = SearchRanking.ordered(merged, query: text)
		phase = .results
	}

	/// Chats that contain every picked person or agent. No one picked keeps the list as it is.
	nonisolated static func withParticipants(_ list: [SearchResult], _ picked: [SearchPerson]) -> [SearchResult] {
		guard !picked.isEmpty else { return list }
		return list.filter { result in picked.allSatisfy { result.participantIds.contains($0.id) } }
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
