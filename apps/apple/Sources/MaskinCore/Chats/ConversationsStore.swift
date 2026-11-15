import Foundation
import MaskinAPI
import Observation

/// A list API that can also delete a conversation. The HTTP API has no such route yet, so
/// `ConversationsStore.delete` removes the row locally when a source lacks this.
public protocol ConversationDeleting: Sendable {
	func delete(conversationID: String) async throws
}

/// The Team list: conversations, flow rooms, archived rows, per-user unread state, live updates,
/// and creating a conversation. One per workspace; the screen rebuilds it when the workspace
/// changes.
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
	/// Archived conversations, for the Archived row at the bottom of Team.
	public private(set) var archivedConversations: [ConversationSummary] = []
	/// More archived pages exist on the server than are loaded in `archivedConversations`.
	public private(set) var archivedHasMore = false
	/// Flow rooms for the FLOWS section; empty with no `FlowRoomsSource`.
	public private(set) var flowRooms: [TeamFlowRoom] = []
	public private(set) var phase: Phase = .idle
	public private(set) var freshness = Freshness()
	public private(set) var hasMore = false
	public private(set) var isLoadingMore = false
	public private(set) var actors: [ChatActor] = []
	/// Threads you are in, newest activity first (the Threads screen and its chip count).
	public private(set) var threads: [ThreadListItem] = []
	@ObservationIgnored private var refreshingThreads = false
	public var threadSections: ThreadListSections { ThreadListSections(threads) }
	/// Last mutation error (pin/archive/read), surfaced by the screen as a transient notice.
	public var notice: String?
	/// Display > Chats > Archived: the list shows the archived chats instead of the active ones.
	public var showsArchivedList = false
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

	// MARK: Team display state (spec 7 §6)

	/// The Display menu's choices, persisted per user.
	public var displayOptions: TeamDisplayOptions {
		didSet {
			preferences?.displayOptions = displayOptions
			if !displayOptions.showsFilterChips { chip = .all }
		}
	}
	/// The active filter chip; only meaningful while chips are shown.
	public var chip: TeamFilterChip = .all
	/// Pinned tiles in the order the user dragged them into, persisted per user.
	public private(set) var pinOrder: [String]
	/// Flows pinned on this device (flows have no server-side pin yet).
	public private(set) var pinnedFlowIDs: Set<String>
	/// Conversations where an agent is typing. No API reports this yet; the thread screen may set
	/// it for the conversation it has open.
	public var typingConversationIDs: Set<String> = []
	/// Conversations whose unread messages mention you. No API reports this yet.
	public var mentionConversationIDs: Set<String> = []

	// MARK: Sections and views (bet: Chat list sections)

	/// The sectioned list is on for this person (a feature flag). Off draws the list as before.
	public var sectionsEnabled = false {
		didSet {
			guard sectionsEnabled != oldValue else { return }
			if sectionsEnabled {
				Task {
					await refreshSections()
					await refreshViews()
				}
			} else {
				activeView = nil
			}
		}
	}
	/// The person's own sections, in order.
	public private(set) var sections: [ChatSection] = []
	/// The open automatic view; nil is the whole list.
	public var activeView: TeamView?
	/// The chats of each automatic view (first page). The tiles count them, the open view lists them.
	public private(set) var viewRows: [TeamView: [ConversationSummary]] = [:]
	/// More chats exist for the view than the first page holds, so its tile reads "40+".
	public private(set) var viewHasMore: Set<TeamView> = []
	/// Views whose last load failed and have nothing to show (the view says "Couldn't load").
	public private(set) var viewFailed: Set<TeamView> = []
	/// This person dismissed the first-view note about chats that left the list.
	public private(set) var quietNoteSeen: Bool

	/// Told after every successful reload of the active, unfiltered list (first load, events,
	/// pull-to-refresh). The thread prefetcher hangs off this.
	@ObservationIgnored public var onListLoaded: (@MainActor ([ConversationSummary]) -> Void)?

	@ObservationIgnored private let api: any ConversationsAPI
	@ObservationIgnored private let flowSource: (any FlowRoomsSource)?
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let preferences: TeamPreferences?
	@ObservationIgnored private let pageSize = 30
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	@ObservationIgnored private var loadingArchived = false
	@ObservationIgnored private var generation = 0
	/// Rows deleted here while the API has no delete: hidden from every later page.
	@ObservationIgnored private var locallyDeleted: Set<String> = []

	public init(
		api: any ConversationsAPI, events: EventHub?, cache: SnapshotCache? = nil,
		flowRooms: (any FlowRoomsSource)? = nil, preferences: TeamPreferences? = nil
	) {
		self.api = api
		self.events = events
		self.cache = cache
		self.flowSource = flowRooms
		self.preferences = preferences
		self.displayOptions = preferences?.displayOptions ?? .default
		self.pinOrder = preferences?.pinOrder ?? []
		self.pinnedFlowIDs = preferences?.pinnedFlowIDs ?? []
		self.quietNoteSeen = preferences?.quietNoteSeen ?? false
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

	/// The Team list for the current options, chip and query (spec 7 §6).
	public func layout(
		query: String = "", currentActorID: String?, expandedSectionIDs: Set<String> = [], now: Date = Date()
	) -> TeamLayout {
		let working = workingAgentIDs
		// A flow works when any of its agents runs; the source may not know run state itself.
		let rooms = flowRooms.map { room in
			var room = room
			room.workingCount = max(room.workingCount, room.loop?.agentIDs.filter(working.contains).count ?? 0)
			return room
		}
		return TeamLayout.build(
			TeamLayout.Input(
				conversations: ConversationGrouping.filter(conversations, agentID: agentFilterID), flowRooms: rooms,
				archived: archivedConversations, options: displayOptions,
				chip: Self.effectiveChip(displayOptions, chip, sectionsEnabled: sectionsEnabled), query: query, currentActorID: currentActorID,
				pinOrder: pinOrder, pinnedFlowIDs: pinnedFlowIDs, expandedSectionIDs: expandedSectionIDs,
				workingAgentIDs: working,
				mentionedConversationIDs: sectionsEnabled ? Set(conversations.filter { $0.mentionsUnread > 0 }.map(\.id)) : mentionConversationIDs,
				sectionsEnabled: sectionsEnabled, sections: sections, view: sectionsEnabled ? activeView : nil,
				viewConversations: activeView.flatMap { viewRows[$0] } ?? [], now: now))
	}

	/// The Unread filter in Display wins over the chip row; otherwise the chip counts only while the
	/// chips are shown.
	nonisolated static func effectiveChip(
		_ options: TeamDisplayOptions, _ chip: TeamFilterChip, sectionsEnabled: Bool = false
	) -> TeamFilterChip {
		// With sections on, Waiting on you replaces the Unread filter and the Unread chip.
		if sectionsEnabled { return options.showsFilterChips && chip != .unread ? chip : .all }
		if options.unreadOnly { return .unread }
		return options.showsFilterChips ? chip : .all
	}

	/// Agents running right now, from the workspace actor list.
	public var workingAgentIDs: Set<String> {
		Set(actors.filter { $0.participant.kind == .agent && $0.agentState == .running }.map(\.id))
	}

	/// The second line of a conversation's row. `draft` and `tick` come from the screen (the draft
	/// store and the send queue live outside this store).
	public func status(
		for conversation: ConversationSummary, draft: String? = nil, tick: ConversationRowStatus.Tick? = nil,
		displayedTitle: String? = nil, me: String? = nil
	) -> ConversationRowStatus {
		let working = conversation.participants.filter { workingAgentIDs.contains($0.id) }
		return ConversationRowStatus.make(
			conversation: conversation, draft: draft, typing: typingConversationIDs.contains(conversation.id),
			workingAgents: working.count, workingNames: working.map { TeamLayout.firstName($0.name) }, tick: tick, mentionsYou: mentionConversationIDs.contains(conversation.id),
			displayedTitle: displayedTitle, me: me)
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
		conversations.first { $0.id == id } ?? archivedConversations.first { $0.id == id }
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
						await self.refreshArchived()
						await self.refreshThreads()
						await self.refreshSections()
						await self.refreshViews()
					case .event(let event) where event.entityType == .conversation:
						await self.refresh()
						await self.refreshThreads()
						await self.refreshSections()
						await self.refreshViews()
					case .event(let event) where event.entityType == .session || event.entityType == .actor:
						// Working state on rows and avatars follows the agents' runs.
						await self.refreshActors()
						await self.refreshFlowRooms()
					case .event:
						break
					}
				}
			}
		}
		// The feature flag is read once here, so every screen that holds a store agrees.
		let enabled = await api.sectionsEnabled()
		if enabled != sectionsEnabled { sectionsEnabled = enabled }
		async let main: Void = refresh()
		async let archived: Void = refreshArchived()
		async let flows: Void = refreshFlowRooms()
		async let people: Void = refreshActors()
		async let threadRows: Void = refreshThreads()
		async let sectionRows: Void = refreshSections()
		async let viewLists: Void = refreshViews()
		_ = await (main, archived, flows, people, threadRows, sectionRows, viewLists)
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
					hideQuiet: hidesQuiet, limit: limit, offset: 0)
				guard mine == generation else { continue }
				// Re-read what's on screen (capped by the server) so paged-in rows survive an event.
				let keptTail = conversations.count > limit
				conversations = ServerLimits.mergeHead(head: page.conversations, previous: conversations)
					.filter { !locallyDeleted.contains($0.id) }
				hasMore = keptTail ? hasMore || page.hasMore : page.hasMore
				phase = .loaded
				reconcileAgentFilter()
				freshness.refreshed(at: cache?.now() ?? Date())
				writeCache()
				if scope == .active, filter == .all { onListLoaded?(conversations) }
			} catch {
				freshness.revalidateFailed()
				if conversations.isEmpty { phase = .failed(Self.message(error)) }
			}
		} while refreshQueued
	}

	/// Only the default list leaves out empty agent DMs, retired agents and quiet topic chats; the
	/// Unread, Pinned and Archived lists show what they filter on.
	private var hidesQuiet: Bool { scope == .active && filter == .all }

	public func loadMore() async {
		guard hasMore, !isLoadingMore, phase == .loaded else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		do {
			let page = try await api.list(
				archived: scope == .archived, pinnedOnly: filter == .pinned, unreadOnly: filter == .unread,
				hideQuiet: hidesQuiet, limit: pageSize, offset: conversations.count)
			let known = Set(conversations.map(\.id))
			conversations += page.conversations.filter { !known.contains($0.id) && !locallyDeleted.contains($0.id) }
			hasMore = page.hasMore
		} catch {
			notice = Self.message(error)
		}
	}

	public func loadActors() async {
		guard actors.isEmpty else { return }
		await refreshActors()
	}

	/// Reload the Threads screen's rows. A failure keeps what is shown; the screen is secondary.
	public func refreshThreads() async {
		guard !refreshingThreads else { return }
		refreshingThreads = true
		defer { refreshingThreads = false }
		if let rows = try? await api.threads(limit: 50) { threads = rows }
	}

	public func refreshActors() async {
		if let fresh = try? await api.actors() { actors = fresh }
	}

	/// The archived list (first page) for the Archived row. Failure keeps what was shown.
	public func refreshArchived() async {
		guard scope == .active else { return }
		if let page = try? await api.list(archived: true, limit: pageSize, offset: 0) {
			archivedConversations = page.conversations.filter { !locallyDeleted.contains($0.id) }
			archivedHasMore = page.hasMore
		}
	}

	/// Pages in the rest of the archived list so a search covers all of it, not just the first
	/// page. Stops at the end, at `archivedPageCap` pages, or when a page adds nothing new.
	public func loadMoreArchived() async {
		guard scope == .active, archivedHasMore, !loadingArchived else { return }
		loadingArchived = true
		defer { loadingArchived = false }
		for _ in 0..<Self.archivedPageCap {
			guard archivedHasMore,
				let page = try? await api.list(archived: true, limit: pageSize, offset: archivedConversations.count)
			else { return }
			let known = Set(archivedConversations.map(\.id))
			let fresh = page.conversations.filter { !known.contains($0.id) && !locallyDeleted.contains($0.id) }
			archivedConversations += fresh
			archivedHasMore = page.hasMore
			if fresh.isEmpty { return }
		}
	}

	/// How many extra archived pages one search will fetch (30 each).
	static let archivedPageCap = 20

	public func refreshFlowRooms() async {
		guard let flowSource else { return }
		if let rooms = try? await flowSource.flowRooms() { flowRooms = rooms }
	}

	// MARK: - Sections and views

	/// The person's sections. Failure keeps what is shown; sections are secondary to the list.
	public func refreshSections() async {
		guard sectionsEnabled else { return }
		if let fresh = try? await api.sections() { sections = fresh.sorted { $0.position < $1.position } }
	}

	/// The first page of each automatic view, for the tiles and the open view.
	public func refreshViews() async {
		guard sectionsEnabled else { return }
		for view in TeamView.allCases {
			do {
				let page = try await api.list(view: view, limit: Self.viewPageSize, offset: 0)
				viewRows[view] = page.conversations.filter { !locallyDeleted.contains($0.id) }
				if page.hasMore { viewHasMore.insert(view) } else { viewHasMore.remove(view) }
				viewFailed.remove(view)
			} catch {
				if viewRows[view] == nil { viewFailed.insert(view) }
			}
		}
	}

	static let viewPageSize = 100

	/// What a tile shows, and whether more than a page exists. Nil while the view has not loaded.
	public func tileCount(_ view: TeamView) -> (count: Int, more: Bool)? {
		guard let rows = viewRows[view] else { return nil }
		return (TeamViewRules.tileCount(view, rows), viewHasMore.contains(view))
	}

	/// Quiet chats that left the list, for the first-view note and the footer line.
	public var quietChatCount: Int { viewRows[.quiet]?.count ?? 0 }

	public func section(id: String) -> ChatSection? { sections.first { $0.id == id } }

	/// The section a chat sits in, if any.
	public func section(containing conversationID: String) -> ChatSection? {
		sections.first { $0.conversationIDs.contains(conversationID) }
	}

	public func dismissQuietNote() {
		quietNoteSeen = true
		preferences?.quietNoteSeen = true
	}

	/// A new section, last in the order. With `chatID` the chat moves in at once. Nil on failure, with
	/// the reason in `notice`.
	@discardableResult
	public func addSection(named name: String, moving chatID: String? = nil) async -> ChatSection? {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return nil }
		guard !TeamViewRules.hasSection(named: trimmed, in: sections) else {
			notice = TeamViewRules.duplicateMessage(trimmed)
			return nil
		}
		do {
			var created = try await api.createSection(name: trimmed)
			created.position = sections.count
			sections.append(created)
			if let chatID { await move(chatID, to: created.id) }
			return section(id: created.id) ?? created
		} catch {
			notice = Self.message(error)
			return nil
		}
	}

	@discardableResult
	public func renameSection(_ id: String, to name: String) async -> Bool {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let before = section(id: id), !trimmed.isEmpty, trimmed != before.name else { return false }
		guard !TeamViewRules.hasSection(named: trimmed, in: sections, excluding: id) else {
			notice = TeamViewRules.duplicateMessage(trimmed)
			return false
		}
		return await mutateSection(id, apply: { $0.name = trimmed }) {
			_ = try await self.api.updateSection(id: id, name: trimmed, collapsed: nil)
		}
	}

	/// Fold or open a section. The server keeps the choice, so it is the same on every device.
	@discardableResult
	public func setSectionCollapsed(_ id: String, _ collapsed: Bool) async -> Bool {
		await mutateSection(id, apply: { $0.collapsed = collapsed }) {
			_ = try await self.api.updateSection(id: id, name: nil, collapsed: collapsed)
		}
	}

	/// Move a section one place up (-1) or down (+1).
	@discardableResult
	public func moveSection(_ id: String, by offset: Int) async -> Bool {
		guard let from = sections.firstIndex(where: { $0.id == id }) else { return false }
		let to = from + offset
		guard sections.indices.contains(to) else { return false }
		let before = sections
		var reordered = sections
		reordered.insert(reordered.remove(at: from), at: to)
		sections = reordered.enumerated().map { index, section in
			var section = section
			section.position = index
			return section
		}
		do {
			try await api.reorderSections(ids: sections.map(\.id))
			return true
		} catch {
			sections = before
			notice = Self.message(error)
			return false
		}
	}

	/// Delete a section; its chats go back to the list. Returns what was removed, for Undo.
	@discardableResult
	public func deleteSection(_ id: String) async -> ChatSection? {
		guard let removed = section(id: id) else { return nil }
		let before = sections
		let beforeRows = conversations
		sections.removeAll { $0.id == id }
		clearSectionID(of: removed.conversationIDs)
		do {
			try await api.deleteSection(id: id)
			return removed
		} catch {
			sections = before
			conversations = beforeRows
			notice = Self.message(error)
			return nil
		}
	}

	/// Undo for a delete: the section comes back under its name with its chats, in its old place.
	@discardableResult
	public func restoreSection(_ removed: ChatSection) async -> Bool {
		guard let created = await addSection(named: removed.name) else { return false }
		for chatID in removed.conversationIDs { await move(chatID, to: created.id) }
		while let index = sections.firstIndex(where: { $0.id == created.id }), index > removed.position {
			guard await moveSection(created.id, by: -1) else { break }
		}
		return true
	}

	/// Puts a chat in a section, or back in the list with a nil section. Returns the section it was
	/// in, so Undo can put it back; nil when nothing changed or the server refused.
	@discardableResult
	public func move(_ conversationID: String, to sectionID: String?) async -> MoveOutcome? {
		let previous = section(containing: conversationID)?.id
		guard previous != sectionID else { return nil }
		let before = sections
		let beforeRows = conversations
		for index in sections.indices { sections[index].conversationIDs.removeAll { $0 == conversationID } }
		if let sectionID, let index = sections.firstIndex(where: { $0.id == sectionID }) {
			sections[index].conversationIDs.insert(conversationID, at: 0)
		}
		update(conversationID) { $0.sectionID = sectionID }
		do {
			if let sectionID {
				try await api.putChat(conversationID, inSection: sectionID)
			} else if let previous {
				try await api.removeChat(conversationID, fromSection: previous)
			}
			// A chat in a section never goes quiet, and one taken out may be quiet again.
			await refreshViews()
			return MoveOutcome(previousSectionID: previous)
		} catch {
			sections = before
			conversations = beforeRows
			notice = Self.message(error)
			return nil
		}
	}

	public struct MoveOutcome: Equatable, Sendable {
		/// The section the chat was in before, nil when it sat in none.
		public var previousSectionID: String?
	}

	private func clearSectionID(of ids: [String]) {
		for id in ids { update(id) { $0.sectionID = nil } }
	}

	@discardableResult
	private func mutateSection(
		_ id: String, apply: (inout ChatSection) -> Void, request: () async throws -> Void
	) async -> Bool {
		guard let index = sections.firstIndex(where: { $0.id == id }) else { return false }
		let before = sections[index]
		apply(&sections[index])
		do {
			try await request()
			return true
		} catch {
			if let current = sections.firstIndex(where: { $0.id == id }) { sections[current] = before }
			notice = Self.message(error)
			return false
		}
	}

	// MARK: - Create

	/// Creates the conversation and puts it at the top of the list. Throws so the sheet can show
	/// the failure and keep the user's input.
	@discardableResult
	public func create(
		title: String, participantIDs: [String], firstMessage: String?,
		firstMessageMetadata: ChatSendMetadata? = nil
	) async throws -> ConversationSummary {
		let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		let message = firstMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
		let hasMessage = !(message?.isEmpty ?? true)
		let created = try await api.create(
			title: trimmed, participantIDs: participantIDs, initialMessage: hasMessage ? message : nil,
			initialMetadata: hasMessage ? firstMessageMetadata : nil, idempotencyKey: IdempotencyKey.make())
		if scope == .active, !conversations.contains(where: { $0.id == created.id }) {
			conversations.insert(created, at: 0)
		}
		return created
	}

	/// A new room: a named chat that stays in the list's Rooms group. Throws like `create`.
	@discardableResult
	public func createRoom(
		title: String, participantIDs: [String], firstMessage: String?,
		firstMessageMetadata: ChatSendMetadata? = nil
	) async throws -> ConversationSummary {
		let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		let message = firstMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
		let hasMessage = !(message?.isEmpty ?? true)
		let created = try await api.createRoom(
			title: trimmed, participantIDs: participantIDs, initialMessage: hasMessage ? message : nil,
			initialMetadata: hasMessage ? firstMessageMetadata : nil, idempotencyKey: IdempotencyKey.make())
		if scope == .active, !conversations.contains(where: { $0.id == created.id }) {
			conversations.insert(created, at: 0)
		}
		return created
	}

	/// "Make this a room" and "Turn back into a chat". The row changes at once and goes back if
	/// the server refuses.
	@discardableResult
	public func setRoom(_ id: String, _ isRoom: Bool) async -> Bool {
		await mutate(id, apply: { $0.roomKind = isRoom ? .free : nil }) {
			try await self.api.setRoom(conversationID: id, isRoom: isRoom)
		}
	}

	/// "Make this a flow" on a room: a new paused flow takes the room's chat as its own.
	@discardableResult
	public func makeFlow(_ id: String) async -> Bool {
		guard let row = conversation(id: id) else { return false }
		do {
			let flowID = try await api.makeFlow(
				conversationID: id, title: row.title, idempotencyKey: IdempotencyKey.make())
			update(id) {
				$0.roomKind = .flow
				$0.flowID = flowID
			}
			return true
		} catch {
			notice = Self.message(error)
			return false
		}
	}

	/// The person's one direct message with `participantID`, created the first time. Throws like
	/// `create`. An archived direct message comes back as it is and is opened by id, so it is only
	/// added to the list when it is already part of it.
	@discardableResult
	public func openDirect(with participantID: String, title: String) async throws -> ConversationSummary {
		let direct = try await api.directChat(
			with: participantID, title: title, idempotencyKey: IdempotencyKey.make())
		if scope == .active, !direct.archived, !conversations.contains(where: { $0.id == direct.id }) {
			conversations.insert(direct, at: 0)
		}
		return direct
	}

	// MARK: - Per-user state (optimistic, rolled back on failure)

	@discardableResult
	public func setPinned(_ id: String, _ pinned: Bool) async -> Bool {
		let ok = await mutate(id, apply: { $0.pinned = pinned }) {
			try await self.api.updateState(
				conversationID: id, pinned: pinned, archived: nil, lastReadMessageID: nil, markUnread: false)
		}
		// The order follows the server's answer: a refused pin leaves the tiles as they were.
		if ok, pinned, !pinOrder.contains(id) { setPinOrder(pinOrder + [id]) }
		if ok, !pinned { setPinOrder(pinOrder.filter { $0 != id }) }
		return ok
	}

	/// Flows pin on this device only until the API has a pin for them.
	public func setFlowPinned(_ flowID: String, _ pinned: Bool) {
		let key = TeamLayout.flowPinKey(flowID)
		if pinned {
			pinnedFlowIDs.insert(flowID)
			if !pinOrder.contains(key) { setPinOrder(pinOrder + [key]) }
		} else {
			pinnedFlowIDs.remove(flowID)
			setPinOrder(pinOrder.filter { $0 != key })
		}
		preferences?.pinnedFlowIDs = pinnedFlowIDs
	}

	/// Drag reorder of the pinned tiles: moves the tile with `id` to where `target` sits. Tiles
	/// not yet in the order are appended first, so a partial order is always well defined.
	public func movePin(_ id: String, before target: String, tiles: [String]) {
		var order = pinOrder
		for key in tiles where !order.contains(key) { order.append(key) }
		guard let from = order.firstIndex(of: id), let to = order.firstIndex(of: target), from != to else { return }
		order.remove(at: from)
		order.insert(id, at: to)
		setPinOrder(order)
	}

	private func setPinOrder(_ order: [String]) {
		pinOrder = order
		preferences?.pinOrder = order
	}

	/// Moves a conversation between the active and archived lists, and back if the server refuses.
	@discardableResult
	public func setArchived(_ id: String, _ archived: Bool) async -> Bool {
		let beforeActive = conversations
		let beforeArchived = archivedConversations
		if archived, let index = conversations.firstIndex(where: { $0.id == id }) {
			var row = conversations.remove(at: index)
			row.archived = true
			if scope == .active { archivedConversations.insert(row, at: 0) }
		} else if !archived, let index = archivedConversations.firstIndex(where: { $0.id == id }) {
			var row = archivedConversations.remove(at: index)
			row.archived = false
			conversations.insert(row, at: 0)
		} else if archived {
			conversations.removeAll { $0.id == id }
		} else {
			// The archive scope lists archived rows in `conversations`: unarchiving drops the row there.
			conversations.removeAll { $0.id == id }
			archivedConversations.removeAll { $0.id == id }
		}
		reconcileAgentFilter()
		do {
			try await api.updateState(
				conversationID: id, pinned: nil, archived: archived, lastReadMessageID: nil, markUnread: false)
			return true
		} catch {
			conversations = beforeActive
			archivedConversations = beforeArchived
			notice = Self.message(error)
			return false
		}
	}

	/// Drops the row after the reader left the conversation. The server already removed them, so
	/// nothing is asked of it; the row just stays out of every later page.
	public func hideAfterLeaving(_ id: String) {
		conversations.removeAll { $0.id == id }
		archivedConversations.removeAll { $0.id == id }
		locallyDeleted.insert(id)
		setPinOrder(pinOrder.filter { $0 != id })
		reconcileAgentFilter()
	}

	/// Removes the row for good. Sources that can delete are asked to; otherwise the row is hidden
	/// on this device only (API follow-up: `DELETE /api/conversations/{id}`).
	public func delete(_ id: String) async {
		let beforeActive = conversations
		let beforeArchived = archivedConversations
		conversations.removeAll { $0.id == id }
		archivedConversations.removeAll { $0.id == id }
		locallyDeleted.insert(id)
		setPinOrder(pinOrder.filter { $0 != id })
		reconcileAgentFilter()
		guard let deleting = api as? any ConversationDeleting else { return }
		do {
			try await deleting.delete(conversationID: id)
		} catch {
			conversations = beforeActive
			archivedConversations = beforeArchived
			locallyDeleted.remove(id)
			notice = Self.message(error)
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
		if let index = conversations.firstIndex(where: { $0.id == id }) {
			change(&conversations[index])
		} else if let index = archivedConversations.firstIndex(where: { $0.id == id }) {
			change(&archivedConversations[index])
		}
	}

	@discardableResult
	private func mutate(
		_ id: String, apply: (inout ConversationSummary) -> Void, request: () async throws -> Void
	) async -> Bool {
		guard let before = conversation(id: id) else { return false }
		update(id, apply)
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
