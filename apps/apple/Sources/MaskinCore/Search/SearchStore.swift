import Foundation
import Observation

/// Debounced, cancellable workspace search. Chats, flows, agents and items come from the server
/// search (`GET /api/search`) in the server's own order, the same as the web; files are searched by
/// name apart and listed last. Nothing is filtered or re-ranked on the phone.
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

	/// Rows asked of the server search, its own default and cap.
	public static let resultLimit = 150
	/// Rows asked of the files search.
	public static let fileLimit = 25

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
	@ObservationIgnored private var peopleTask: Task<Void, Never>?
	@ObservationIgnored private let currentActorId: @MainActor () -> String?
	/// When, and for which workspace, the people list was filled.
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

	/// Results in the chosen scope, grouped in display order. Inside a group the server's order is kept.
	public var sections: [SearchSection] {
		SearchGroup.displayOrder.compactMap { group in
			let rows = allResults.filter { $0.group == group && scope.includes($0, objectType: objectType) }
			return rows.isEmpty ? nil : SearchSection(group: group, results: rows)
		}
	}

	/// The sub-chips under Objects: the types the current results contain.
	public var objectTypes: [String] { SearchScope.objectTypes(in: allResults) }

	/// The results in the chosen scope, in the server's order across groups (files last).
	public var rows: [SearchResult] {
		allResults.filter { scope.includes($0, objectType: objectType) }
	}

	public var visibleCount: Int { rows.count }

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
			if let loaded {
				self.people = loaded
				self.cacheStamp = (startWorkspace, self.now())
			} else {
				self.peopleTask = nil
			}
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

	// MARK: Changes from a row menu

	/// Takes a result out of the list. For a chat that was archived or deleted from its menu; the
	/// server no longer returns it, so it stays gone when the words change.
	public func remove(_ result: SearchResult) {
		allResults.removeAll { $0.id == result.id }
	}

	/// Shows an object's new status on its row, after its status changed from the row menu.
	public func setStatus(_ status: String, ofObject id: String) {
		let subtitle = status.replacingOccurrences(of: "_", with: " ")
		for index in allResults.indices where allResults[index].kind == .object && allResults[index].entityId == id {
			allResults[index].subtitle = subtitle
		}
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

	/// Drops the people list the @ menu offers (workspace switch).
	public func invalidateDirectories() {
		cacheStamp = nil
		peopleTask?.cancel()
		peopleTask = nil
		people = []
	}

	/// Drops the people list when it belongs to another workspace or is older than the TTL.
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
		let limit = Self.resultLimit
		let fileLimit = Self.fileLimit
		expireStaleDirectories()
		let startWorkspace = workspaceId()
		let picked = participants.map(\.id)
		// With people picked only chats can match, so files are not asked.
		let chatsOnly = !picked.isEmpty

		async let server = Self.attempt { () async throws -> SearchAnswer in
			try await remote.search(query: text, participants: picked, limit: limit)
		}
		async let files = Self.attempt { () async throws -> [SearchResult] in
			if chatsOnly { return [] }
			return try await remote.searchFiles(query: text, limit: fileLimit)
		}
		let (s, f) = await (server, files)
		// A newer query (or a cancel) started while this one was in flight.
		guard mine == generation, !Task.isCancelled else { return }
		// The workspace changed while this was in flight: these rows belong to the old one.
		guard startWorkspace == workspaceId() else {
			invalidateDirectories()
			await run(text, generation: mine)
			return
		}

		let errors = [s.failureValue, chatsOnly ? nil : f.failureValue].compactMap { $0 }
		if case .failure(let first) = s, chatsOnly || f.failureValue != nil {
			allResults = []
			isOffline = first.isOffline
			isPartial = false
			phase = .failed(first.message)
			return
		}
		isOffline = false
		isPartial = !errors.isEmpty
		var merged: [SearchResult] = []
		if case .success(let answer) = s {
			merged += answer.results
			if answer.isPartial { isPartial = true }
		}
		if !chatsOnly, case .success(let list) = f { merged += list }
		allResults = merged
		phase = .results
	}

	private nonisolated static func attempt<T: Sendable>(
		_ work: @Sendable () async throws -> T
	) async -> Result<T, SearchError> {
		do { return .success(try await work()) } catch {
			return .failure((error as? SearchError) ?? RemoteFailure.searchError(error))
		}
	}
}

private extension Result {
	var failureValue: Failure? {
		if case .failure(let error) = self { return error }
		return nil
	}
}
