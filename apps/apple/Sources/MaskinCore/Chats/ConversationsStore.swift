import Foundation
import MaskinAPI
import Observation

/// The Chats list: conversations grouped by recency, per-user unread state, live updates, and
/// creating a conversation. One per workspace; the screen rebuilds it when the workspace changes.
@MainActor
@Observable
public final class ConversationsStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public enum Scope: Sendable { case active, archived }
	/// Narrows the active list on the server (so a filtered list pages correctly).
	public enum Filter: Sendable, CaseIterable { case all, unread, pinned }

	public private(set) var conversations: [ConversationSummary] = []
	public private(set) var phase: Phase = .idle
	public private(set) var freshness = Freshness()
	public private(set) var hasMore = false
	public private(set) var isLoadingMore = false
	public private(set) var actors: [ChatActor] = []
	/// Last mutation error (pin/archive/read), surfaced by the screen as a transient notice.
	public var notice: String?
	public var scope: Scope = .active {
		didSet { if scope != oldValue { Task { await refresh() } } }
	}
	/// Narrows the loaded list to conversations an agent takes part in (client-side).
	public var agentFilterID: String?
	/// The Display menu's layout: by person, or one list (the screen remembers the choice).
	public var groupBy: ConversationGroupBy = .person
	public var filter: Filter = .all {
		didSet {
			guard filter != oldValue else { return }
			conversations = []
			Task { await refresh() }
		}
	}

	@ObservationIgnored private let api: any ConversationsAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let pageSize = 30
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	@ObservationIgnored private var generation = 0

	public init(api: any ConversationsAPI, events: EventHub?, cache: SnapshotCache? = nil) {
		self.api = api
		self.events = events
		self.cache = cache
		hydrateIfNeeded()
	}

	/// First frame from disk: the unfiltered active list, before any network call.
	func hydrateIfNeeded() {
		guard phase == .idle, conversations.isEmpty, scope == .active, filter == .all,
			let entry = cache?.read(
				ChatCaching.ListSnapshot.self, ChatCaching.listName, version: ChatCaching.version)
		else { return }
		conversations = entry.value.conversations
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
	}

	private func writeCache() {
		guard scope == .active, filter == .all else { return }
		cache?.write(
			ChatCaching.ListSnapshot(
				conversations: Array(conversations.prefix(ChatCaching.listLimit))),
			ChatCaching.listName, version: ChatCaching.version)
	}

	public var totalUnread: Int { conversations.reduce(0) { $0 + $1.unreadCount } }

	public func groups(query: String = "", now: Date = Date()) -> [ConversationGroup] {
		let filtered = ConversationGrouping.filter(
			ConversationGrouping.filter(conversations, agentID: agentFilterID), query: query)
		if scope == .archived {
			return filtered.isEmpty
				? [] : [ConversationGroup(key: .earlier, label: "Archived", items: filtered)]
		}
		if !query.trimmingCharacters(in: .whitespaces).isEmpty {
			guard !filtered.isEmpty else { return [] }
			let label = "\(filtered.count) \(filtered.count == 1 ? "result" : "results")"
			return [ConversationGroup(key: .results, label: label, items: filtered)]
		}
		return ConversationGrouping.group(filtered, now: now)
	}

	/// The flat list as the Team screen draws it: pinned tiles, then day groups. A search or the
	/// archive has no tiles and one flat group, as in `groups`.
	public func sections(query: String = "", now: Date = Date()) -> ConversationListSections {
		let flat = groups(query: query, now: now)
		if scope == .archived || isSearching(query) { return ConversationListSections(pinned: [], groups: flat) }
		return ConversationGrouping.sections(
			ConversationGrouping.filter(conversations, agentID: agentFilterID), now: now)
	}

	/// The person view: pinned tiles, UNREAD, PEOPLE & AGENTS. Nil in the archive and while
	/// searching, which show one flat list (`sections`).
	public func teamSections(query: String = "", currentActorID: String?) -> TeamSections? {
		guard scope == .active, !isSearching(query) else { return nil }
		return ConversationGrouping.teamSections(
			ConversationGrouping.filter(conversations, agentID: agentFilterID),
			currentActorID: currentActorID)
	}

	private func isSearching(_ query: String) -> Bool {
		!query.trimmingCharacters(in: .whitespaces).isEmpty
	}

	/// The filter menu only lists agents in the current list, so a filter on an agent that is no
	/// longer there (archived away, other scope, left the chats) would leave an empty list with no
	/// way to turn it off. Drop it. Only called once a list has actually loaded: an empty list
	/// mid-reload says nothing about the agent.
	private func reconcileAgentFilter() {
		if let id = agentFilterID, !agentsInList.contains(where: { $0.id == id }) { agentFilterID = nil }
	}

	/// Agents that appear in the loaded conversations, for the filter menu.
	public var agentsInList: [ChatParticipant] {
		var seen: Set<String> = []
		return conversations.flatMap(\.participants).filter { $0.kind == .agent && seen.insert($0.id).inserted }
			.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
	}

	/// Actor ids in order of how recently you talked with them (newest conversation first).
	public var recentCollaboratorIDs: [String] {
		var seen: Set<String> = []
		return conversations.flatMap(\.participants).map(\.id).filter { seen.insert($0).inserted }
	}

	public func conversation(id: String) -> ConversationSummary? {
		conversations.first { $0.id == id }
	}

	// MARK: - Loading

	/// Initial load plus the live subscription. Safe to call repeatedly.
	public func start() async {
		hydrateIfNeeded()
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected:
						await self.refresh()
					case .event(let event) where event.entityType == .conversation:
						await self.refresh()
					case .event:
						break
					}
				}
			}
		}
		await refresh()
	}

	public func stop() {
		listener?.cancel()
		listener = nil
	}

	/// Reload the first page. Overlapping calls coalesce into one trailing reload so a burst of
	/// events (every message posts one) costs two requests, not N.
	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			generation += 1
			let mine = generation
			if conversations.isEmpty { phase = .loading }
			do {
				let limit = ServerLimits.refreshLimit(minimum: pageSize, loaded: conversations.count)
				let page = try await api.list(
					archived: scope == .archived, pinnedOnly: filter == .pinned, unreadOnly: filter == .unread,
					limit: limit, offset: 0)
				guard mine == generation else { continue }
				// Re-read what's on screen (capped by the server) so paged-in rows survive an event.
				let keptTail = conversations.count > limit
				conversations = ServerLimits.mergeHead(head: page.conversations, previous: conversations)
				hasMore = keptTail ? hasMore || page.hasMore : page.hasMore
				phase = .loaded
				reconcileAgentFilter()
				freshness.refreshed(at: cache?.now() ?? Date())
				writeCache()
			} catch {
				freshness.revalidateFailed()
				if conversations.isEmpty { phase = .failed(Self.message(error)) }
			}
		} while refreshQueued
	}

	public func loadMore() async {
		guard hasMore, !isLoadingMore, phase == .loaded else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		do {
			let page = try await api.list(
				archived: scope == .archived, pinnedOnly: filter == .pinned, unreadOnly: filter == .unread,
				limit: pageSize, offset: conversations.count)
			let known = Set(conversations.map(\.id))
			conversations += page.conversations.filter { !known.contains($0.id) }
			hasMore = page.hasMore
		} catch {
			notice = Self.message(error)
		}
	}

	public func loadActors() async {
		guard actors.isEmpty else { return }
		actors = (try? await api.actors()) ?? []
	}

	// MARK: - Create

	/// Creates the conversation and puts it at the top of the list. Throws so the sheet can show
	/// the failure and keep the user's input.
	@discardableResult
	public func create(title: String, participantIDs: [String], firstMessage: String?) async throws
		-> ConversationSummary
	{
		let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		let message = firstMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
		let created = try await api.create(
			title: trimmed, participantIDs: participantIDs,
			initialMessage: (message?.isEmpty ?? true) ? nil : message, idempotencyKey: IdempotencyKey.make())
		if scope == .active, !conversations.contains(where: { $0.id == created.id }) {
			conversations.insert(created, at: 0)
		}
		return created
	}

	// MARK: - Per-user state (optimistic, rolled back on failure)

	@discardableResult
	public func setPinned(_ id: String, _ pinned: Bool) async -> Bool {
		await mutate(id, apply: { $0.pinned = pinned }) {
			try await self.api.updateState(
				conversationID: id, pinned: pinned, archived: nil, lastReadMessageID: nil, markUnread: false)
		}
	}

	@discardableResult
	public func setArchived(_ id: String, _ archived: Bool) async -> Bool {
		let before = conversations
		conversations.removeAll { $0.id == id }
		reconcileAgentFilter()
		do {
			try await api.updateState(
				conversationID: id, pinned: nil, archived: archived, lastReadMessageID: nil, markUnread: false)
			return true
		} catch {
			conversations = before
			notice = Self.message(error)
			return false
		}
	}

	/// Bulk archive/unarchive: one optimistic write per chat, each rolled back on its own failure.
	@discardableResult
	public func setArchived(_ ids: [String], _ archived: Bool) async -> BulkResult {
		var result = BulkResult()
		for id in ids {
			if await setArchived(id, archived) { result.succeeded += 1 } else { result.failed += 1 }
		}
		if let text = result.failureNotice(
			action: archived ? "archive" : "unarchive", past: archived ? "archived" : "unarchived", noun: "chat")
		{
			notice = text
		}
		return result
	}

	/// Bulk pin/unpin, per chat.
	@discardableResult
	public func setPinned(_ ids: [String], _ pinned: Bool) async -> BulkResult {
		var result = BulkResult()
		for id in ids {
			if await setPinned(id, pinned) { result.succeeded += 1 } else { result.failed += 1 }
		}
		if let text = result.failureNotice(
			action: pinned ? "pin" : "unpin", past: pinned ? "pinned" : "unpinned", noun: "chat")
		{
			notice = text
		}
		return result
	}

	/// Bulk mark-as-unread, per chat.
	@discardableResult
	public func markUnread(_ ids: [String]) async -> BulkResult {
		var result = BulkResult()
		for id in ids {
			if await markUnread(id) { result.succeeded += 1 } else { result.failed += 1 }
		}
		if let text = result.failureNotice(action: "mark", past: "marked", noun: "chat") { notice = text }
		return result
	}

	@discardableResult
	public func markUnread(_ id: String) async -> Bool {
		await mutate(id, apply: { $0.unreadCount = max($0.unreadCount, 1) }) {
			try await self.api.updateState(
				conversationID: id, pinned: nil, archived: nil, lastReadMessageID: nil, markUnread: true)
		}
	}

	/// Mark a conversation read up to `messageID`. Local-only when the thread screen already
	/// told the server (`serverAlreadyKnows`).
	public func markRead(_ id: String, upTo messageID: Int? = nil, serverAlreadyKnows: Bool = false) async {
		guard conversation(id: id)?.isUnread == true || messageID != nil else { return }
		if serverAlreadyKnows {
			update(id) { $0.unreadCount = 0 }
			// A list fetch already in flight was computed before this read: its stale unread count
			// would put the badge back, and nothing else would clear it. Discard it and re-read.
			if refreshing {
				generation += 1
				refreshQueued = true
			}
			return
		}
		guard let messageID else { return }
		await mutate(id, apply: { $0.unreadCount = 0 }) {
			try await self.api.updateState(
				conversationID: id, pinned: nil, archived: nil, lastReadMessageID: messageID, markUnread: false)
		}
	}

	/// Mark every listed chat read (the UNREAD card's "Mark all read"): one optimistic write per
	/// chat, each rolled back on its own failure. A chat that is already read is skipped.
	@discardableResult
	public func markRead(_ ids: [String]) async -> BulkResult {
		var result = BulkResult()
		for id in ids where conversation(id: id)?.isUnread == true {
			if await markReadThroughLatest(id) { result.succeeded += 1 } else { result.failed += 1 }
		}
		if let text = result.failureNotice(action: "mark", past: "marked read", noun: "chat") { notice = text }
		return result
	}

	private func markReadThroughLatest(_ id: String) async -> Bool {
		let latest: Int?
		do { latest = try await api.latestMessageID(conversationID: id) } catch { return false }
		guard let latest else { return false }
		return await mutate(id, apply: { $0.unreadCount = 0 }) {
			try await self.api.updateState(
				conversationID: id, pinned: nil, archived: nil, lastReadMessageID: latest, markUnread: false)
		}
	}

	private func update(_ id: String, _ change: (inout ConversationSummary) -> Void) {
		guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
		change(&conversations[index])
	}

	@discardableResult
	private func mutate(
		_ id: String, apply: (inout ConversationSummary) -> Void, request: () async throws -> Void
	) async -> Bool {
		guard let index = conversations.firstIndex(where: { $0.id == id }) else { return false }
		let before = conversations[index]
		apply(&conversations[index])
		do {
			try await request()
			return true
		} catch {
			update(id) { $0 = before }
			notice = Self.message(error)
			return false
		}
	}

	static func message(_ error: Error) -> String {
		(error as? ChatsError)?.message ?? error.localizedDescription
	}
}
