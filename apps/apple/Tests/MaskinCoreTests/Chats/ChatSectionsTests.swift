import Foundation
import Testing

@testable import MaskinCore

private var cal: Calendar {
	var c = Calendar(identifier: .gregorian)
	c.timeZone = TimeZone(secondsFromGMT: 0)!
	return c
}

private let now = Date(timeIntervalSince1970: Double(1_790_000_000 - 1_790_000_000 % 86_400 + 12 * 3600))

private func ago(days: Double = 0, hours: Double = 0) -> Date {
	now.addingTimeInterval(-days * 86_400 - hours * 3600)
}

private func chat(
	_ id: String, days: Double = 0, hours: Double = 1, unread: Int = 0, mentions: Int = 0, cards: Int = 0,
	cardText: String? = nil, running: Bool = false, pinned: Bool = false, direct: Bool = false, room: RoomKind? = nil
) -> ConversationSummary {
	ConversationSummary(
		id: id, title: "Chat \(id)", lastMessageAt: ago(days: days, hours: hours), createdAt: ago(days: 30),
		pinned: pinned, unreadCount: unread, directPairKey: direct ? "pair-\(id)" : nil,
		participants: [chatMe, chatRelay], roomKind: room, mentionsUnread: mentions, openCards: cards,
		cardText: cardText, agentRunning: running)
}

private func section(_ id: String, _ name: String, position: Int = 0, collapsed: Bool = false, chats: [String] = [])
	-> ChatSection
{
	ChatSection(id: id, name: name, position: position, collapsed: collapsed, conversationIDs: chats)
}

private func layout(
	_ conversations: [ConversationSummary], sections: [ChatSection] = [], enabled: Bool = true,
	view: TeamView? = nil, viewRows: [ConversationSummary] = [], chip: TeamFilterChip = .all, query: String = ""
) -> TeamLayout {
	TeamLayout.build(
		TeamLayout.Input(
			conversations: conversations, options: TeamDisplayOptions(grouping: .byTime), chip: chip, query: query,
			currentActorID: "me", sectionsEnabled: enabled, sections: sections, view: view,
			viewConversations: viewRows, now: now, calendar: cal))
}

@Suite("TeamViewRules")
struct TeamViewRulesTests {
	@Test("a view says why a chat is there")
	func reasons() {
		#expect(TeamViewRules.reason(for: .running, chat("a"), now: now) == "Agent running now")
		#expect(
			TeamViewRules.reason(for: .quiet, chat("a", days: 9, hours: 0), now: now, calendar: cal)
				== "Last message 9 days ago")
		#expect(
			TeamViewRules.reason(for: .quiet, chat("a", days: 1, hours: 0), now: now, calendar: cal)
				== "Last message 1 day ago")
		#expect(
			TeamViewRules.reason(for: .waiting, chat("a", mentions: 1, cardText: "Ship it?"), now: now)
				== "Mentions you: \"Ship it?\"")
		#expect(TeamViewRules.reason(for: .waiting, chat("a", mentions: 1), now: now) == "Mentions you")
		#expect(
			TeamViewRules.reason(for: .waiting, chat("a", cards: 1, cardText: "Need a key"), now: now)
				== "Asks you: \"Need a key\"")
		#expect(TeamViewRules.reason(for: .waiting, chat("a"), now: now) == nil)
	}

	@Test("a tile counts what waits for Waiting on you and chats for the others")
	func tileCount() {
		let rows = [chat("a", mentions: 2, cards: 1), chat("b", cards: 1)]
		#expect(TeamViewRules.tileCount(.waiting, rows) == 4)
		#expect(TeamViewRules.tileCount(.running, rows) == 2)
		#expect(TeamViewRules.tileCount(.quiet, []) == 0)
	}

	@Test("the badge is what waits on you, except in a direct chat where every message counts")
	func badge() {
		#expect(chat("a", unread: 5, mentions: 1, cards: 1).badgeCount == 2)
		#expect(chat("a", unread: 5).badgeCount == 0)
		#expect(chat("a", unread: 5).hasQuietNews)
		#expect(chat("a", unread: 3, direct: true).badgeCount == 3)
		#expect(!chat("a", unread: 3, direct: true).hasQuietNews)
		#expect(!chat("a", unread: 3, mentions: 1).hasQuietNews)
		#expect([chat("a", mentions: 1), chat("b", cards: 2), chat("c", unread: 4)].waitingBadgeTotal == 3)
	}

	@Test("the quiet bar shows only for a chat nothing keeps in the list")
	func quietBar() {
		let old = chat("a", days: 9, hours: 0)
		#expect(TeamViewRules.showsQuietBar(old, sections: [], now: now, calendar: cal))
		#expect(!TeamViewRules.showsQuietBar(chat("a", days: 2), sections: [], now: now, calendar: cal))
		#expect(!TeamViewRules.showsQuietBar(chat("a", days: 9, pinned: true), sections: [], now: now, calendar: cal))
		#expect(!TeamViewRules.showsQuietBar(chat("a", days: 9, room: .free), sections: [], now: now, calendar: cal))
		#expect(!TeamViewRules.showsQuietBar(chat("a", days: 9, running: true), sections: [], now: now, calendar: cal))
		#expect(
			!TeamViewRules.showsQuietBar(old, sections: [section("s", "Work", chats: ["a"])], now: now, calendar: cal))
	}

	@Test("a taken name is refused, ignoring case and the section being renamed")
	func duplicateNames() {
		let sections = [section("s1", "Work"), section("s2", "Home")]
		#expect(TeamViewRules.hasSection(named: " work ", in: sections))
		#expect(!TeamViewRules.hasSection(named: "work", in: sections, excluding: "s1"))
		#expect(!TeamViewRules.hasSection(named: "Play", in: sections))
		#expect(TeamViewRules.duplicateMessage(" Work ") == "You already have a section called Work.")
		#expect(
			TeamViewRules.deletedMessage(name: "Work", chats: 1) == "Deleted Work. 1 chat is back in your list.")
		#expect(
			TeamViewRules.deletedMessage(name: "Work", chats: 3) == "Deleted Work. 3 chats are back in your list.")
		#expect(TeamViewRules.quietChats(1) == "1 quiet chat")
		#expect(TeamViewRules.quietChats(4) == "4 quiet chats")
	}
}

@Suite("TeamLayout sections")
struct TeamLayoutSectionsTests {
	@Test("sections off draws the list as before: raw unread numbers, no custom sections")
	func off() {
		let result = layout([chat("a", unread: 3)], sections: [section("s", "Work", chats: ["a"])], enabled: false)
		#expect(result.sections.allSatisfy { $0.kind != .custom })
		#expect(result.unreadCount == 1)
	}

	@Test("a chat in a section lists there and nowhere else, pinned ones first, empty sections stay")
	func sectioned() {
		let chats = [chat("a"), chat("b", pinned: true), chat("c"), chat("loose")]
		let result = layout(
			chats,
			sections: [
				section("s2", "Later", position: 1),
				section("s1", "Work", position: 0, chats: ["a", "b", "c"]),
			])
		let custom = result.sections.filter { $0.kind == .custom }
		#expect(custom.map(\.label) == ["Work", "Later"])
		#expect(custom[0].rows.map(\.id) == ["b", "a", "c"])
		#expect(custom[1].rows.isEmpty)
		#expect(result.tiles.isEmpty)
		let others = result.sections.filter { $0.kind != .custom }.flatMap(\.rows).map(\.id)
		#expect(others == ["loose"])
		#expect(result.sections.first?.sectionID == "s1")
	}

	@Test("a collapsed section keeps its server value and its badge counts what waits on you")
	func collapsedAndBadge() {
		let result = layout(
			[chat("a", unread: 9, mentions: 1, cards: 1), chat("b", unread: 4)],
			sections: [section("s", "Work", collapsed: true, chats: ["a", "b"])])
		let work = result.sections.first { $0.kind == .custom }
		#expect(work?.collapsed == true)
		#expect(work?.badge == 2)
		#expect(work?.count == 2)
	}

	@Test("a search or a chip finds a chat where it is, not hidden in its section")
	func searchIgnoresSections() {
		let sections = [section("s", "Work", chats: ["a"])]
		let searched = layout([chat("a"), chat("b")], sections: sections, query: "Chat a")
		#expect(searched.sections.allSatisfy { $0.kind != .custom })
		#expect(searched.conversationIDs.contains("a"))
	}

	@Test("a chat in a section is not also a Pinned tile")
	func pinnedInSection() {
		let result = layout([chat("a", pinned: true)], sections: [section("s", "Work", chats: ["a"])])
		#expect(result.tiles.isEmpty)
	}

	@Test("rows carry what waits on you, and a hollow dot for news with nothing for you")
	func badges() {
		let result = layout([chat("a", unread: 6, mentions: 1, cards: 1), chat("b", unread: 6)])
		let rows = result.sections.flatMap(\.rows)
		let byID = Dictionary(
			uniqueKeysWithValues: rows.compactMap { row -> (String, ConversationSummary)? in
				if case .conversation(let c) = row.kind { return (c.id, c) }
				return nil
			})
		#expect(byID["a"]?.unreadCount == 2)
		#expect(byID["a"]?.showsQuietDot == false)
		#expect(byID["b"]?.unreadCount == 0)
		#expect(byID["b"]?.showsQuietDot == true)
		// With no Unread group, a chat with news stays in its time group.
		#expect(result.sections.allSatisfy { $0.kind != .unread })
	}

	@Test("a running chat lists under Running, not Working")
	func runningGroup() {
		let result = layout([chat("a", running: true), chat("b")])
		let running = result.sections.first { $0.kind == .working }
		#expect(running?.label == "Running")
		#expect(running?.rows.map(\.id) == ["a"])
	}

	@Test("an open view is one flat list, newest first, from the server's rows")
	func openView() {
		let result = layout(
			[chat("a")], view: .waiting,
			viewRows: [chat("old", days: 3, mentions: 1), chat("new", hours: 1, cards: 1)])
		#expect(result.tiles.isEmpty)
		#expect(result.sections.count == 1)
		#expect(result.sections[0].kind == .view(.waiting))
		#expect(result.sections[0].rows.map(\.id) == ["new", "old"])
		#expect(result.sections[0].showsMarkAllRead)
		// The same row in Running carries no Mark mentions read.
		let running = layout([], view: .running, viewRows: [chat("r", running: true)])
		#expect(running.sections[0].showsMarkAllRead == false)
	}

	@Test("an open view with nothing in it keeps its section, so the screen can say so")
	func emptyView() {
		let result = layout([chat("a")], view: .quiet, viewRows: [])
		#expect(result.sections.map(\.kind) == [.view(.quiet)])
		#expect(result.sections[0].rows.isEmpty)
	}

	@Test("a row opened from a section or a view reports its place")
	func tracking() {
		let sectioned = layout([chat("a")], sections: [section("s", "Work", chats: ["a"])])
		#expect(sectioned.chatListPlace(of: "a", searching: false)?.section == .custom)
		let inView = layout([], view: .running, viewRows: [chat("r", running: true)])
		#expect(inView.chatListPlace(of: "r", searching: false)?.section == .running)
		let waiting = layout([], view: .waiting, viewRows: [chat("w", mentions: 1)])
		#expect(waiting.chatListPlace(of: "w", searching: false)?.section == .waiting)
		#expect(ChatListTracking.Section.quiet.rawValue == "quiet")
	}

	@Test("with sections on, the Unread chip is dropped")
	func unreadChipDropped() {
		var options = TeamDisplayOptions()
		options.showsFilterChips = true
		options.unreadOnly = true
		#expect(ConversationsStore.effectiveChip(options, .unread, sectionsEnabled: true) == .all)
		#expect(ConversationsStore.effectiveChip(options, .people, sectionsEnabled: true) == .people)
	}
}

private actor SectionsAPI: ConversationsAPI {
	var rows: [ConversationSummary]
	var stored: [ChatSection]
	var viewRowsByView: [TeamView: [ConversationSummary]] = [:]
	var failWrites = false
	var calls: [String] = []

	init(rows: [ConversationSummary], sections: [ChatSection] = []) {
		self.rows = rows
		self.stored = sections
	}

	func setFailWrites(_ v: Bool) { failWrites = v }
	func setViewRows(_ view: TeamView, _ value: [ConversationSummary]) { viewRowsByView[view] = value }

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws -> ConversationPage {
		ConversationPage(conversations: archived ? [] : rows, hasMore: false)
	}
	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String) async throws -> ConversationSummary {
		chatConvo("new")
	}
	func updateState(conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool) async throws {}
	func actors() async throws -> [ChatActor] { [] }

	func list(view: TeamView, limit: Int, offset: Int) async throws -> ConversationPage {
		ConversationPage(conversations: viewRowsByView[view] ?? [], hasMore: false)
	}
	func sectionsEnabled() async -> Bool { true }
	func sections() async throws -> [ChatSection] { stored }
	func createSection(name: String) async throws -> ChatSection {
		if failWrites { throw ChatsError("nope") }
		calls.append("create \(name)")
		let made = ChatSection(id: "id-\(name)", name: name, position: stored.count)
		stored.append(made)
		return made
	}
	func updateSection(id: String, name: String?, collapsed: Bool?) async throws -> ChatSection {
		if failWrites { throw ChatsError("nope") }
		calls.append("update \(id) name=\(name ?? "-") collapsed=\(collapsed.map(String.init) ?? "-")")
		return stored.first { $0.id == id } ?? ChatSection(id: id, name: name ?? "")
	}
	func deleteSection(id: String) async throws {
		if failWrites { throw ChatsError("nope") }
		calls.append("delete \(id)")
		stored.removeAll { $0.id == id }
	}
	func reorderSections(ids: [String]) async throws {
		if failWrites { throw ChatsError("nope") }
		calls.append("order \(ids.joined(separator: ","))")
	}
	func putChat(_ conversationID: String, inSection sectionID: String) async throws {
		if failWrites { throw ChatsError("nope") }
		calls.append("put \(conversationID) in \(sectionID)")
	}
	func removeChat(_ conversationID: String, fromSection sectionID: String) async throws {
		if failWrites { throw ChatsError("nope") }
		calls.append("remove \(conversationID) from \(sectionID)")
	}
}

@Suite("ConversationsStore sections")
@MainActor
struct ConversationsStoreSectionsTests {
	private func started(
		_ api: SectionsAPI
	) async -> ConversationsStore {
		let store = ConversationsStore(api: api, events: nil)
		await store.start()
		return store
	}

	@Test("start reads the flag once and loads the sections and the three views")
	func startLoads() async {
		let api = SectionsAPI(
			rows: [chat("a"), chat("b")], sections: [section("s", "Work", chats: ["a"])])
		await api.setViewRows(.waiting, [chat("a", mentions: 2, cards: 1)])
		await api.setViewRows(.running, [chat("b", running: true)])
		let store = await started(api)
		#expect(store.sectionsEnabled)
		#expect(store.sections.map(\.name) == ["Work"])
		#expect(store.tileCount(.waiting)?.count == 3)
		#expect(store.tileCount(.running)?.count == 1)
		#expect(store.tileCount(.quiet)?.count == 0)
		#expect(store.section(containing: "a")?.id == "s")
	}

	@Test("moving a chat is optimistic, calls the server and tells Undo where it came from")
	func moveAndUndo() async {
		let api = SectionsAPI(
			rows: [chat("a")], sections: [section("s1", "Work", chats: ["a"]), section("s2", "Home", position: 1)])
		let store = await started(api)
		let outcome = await store.move("a", to: "s2")
		#expect(outcome?.previousSectionID == "s1")
		#expect(store.section(containing: "a")?.id == "s2")
		#expect(store.conversation(id: "a")?.sectionID == "s2")
		let back = await store.move("a", to: nil)
		#expect(back?.previousSectionID == "s2")
		#expect(store.section(containing: "a") == nil)
		#expect(await api.calls == ["put a in s2", "remove a from s2"])
		#expect(await store.move("a", to: nil) == nil)
	}

	@Test("a refused move goes back and says so")
	func moveRollsBack() async {
		let api = SectionsAPI(rows: [chat("a")], sections: [section("s1", "Work")])
		let store = await started(api)
		await api.setFailWrites(true)
		#expect(await store.move("a", to: "s1") == nil)
		#expect(store.section(containing: "a") == nil)
		#expect(store.notice == "nope")
	}

	@Test("a taken name never reaches the server; a new section can take a chat in the same step")
	func addSection() async {
		let api = SectionsAPI(rows: [chat("a")], sections: [section("s1", "Work")])
		let store = await started(api)
		#expect(await store.addSection(named: " work ") == nil)
		#expect(store.notice == "You already have a section called work.")
		#expect(await api.calls.isEmpty)
		let made = await store.addSection(named: "Home", moving: "a")
		#expect(made?.id == "id-Home")
		#expect(store.section(containing: "a")?.id == "id-Home")
		#expect(await api.calls == ["create Home", "put a in id-Home"])
	}

	@Test("rename and fold are optimistic and roll back")
	func renameAndFold() async {
		let api = SectionsAPI(rows: [], sections: [section("s1", "Work"), section("s2", "Home", position: 1)])
		let store = await started(api)
		#expect(await store.renameSection("s1", to: "Home") == false)
		#expect(await store.renameSection("s1", to: "Job"))
		#expect(store.section(id: "s1")?.name == "Job")
		#expect(await store.setSectionCollapsed("s1", true))
		#expect(store.section(id: "s1")?.collapsed == true)
		await api.setFailWrites(true)
		#expect(await store.setSectionCollapsed("s1", false) == false)
		#expect(store.section(id: "s1")?.collapsed == true)
	}

	@Test("moving a section up or down sends the whole order; the first cannot go up")
	func reorder() async {
		let api = SectionsAPI(
			rows: [], sections: [section("s1", "A"), section("s2", "B", position: 1), section("s3", "C", position: 2)])
		let store = await started(api)
		#expect(await store.moveSection("s1", by: -1) == false)
		#expect(await store.moveSection("s3", by: -1))
		#expect(store.sections.map(\.id) == ["s1", "s3", "s2"])
		#expect(store.sections.map(\.position) == [0, 1, 2])
		#expect(await api.calls == ["order s1,s3,s2"])
	}

	@Test("deleting a section sends its chats back, and Undo brings it back with them in its old place")
	func deleteAndRestore() async {
		let api = SectionsAPI(
			rows: [chat("a"), chat("b")],
			sections: [section("s1", "Work", chats: ["a", "b"]), section("s2", "Home", position: 1)])
		let store = await started(api)
		let removed = await store.deleteSection("s1")
		#expect(removed?.conversationIDs == ["a", "b"])
		#expect(store.section(containing: "a") == nil)
		#expect(store.conversation(id: "a")?.sectionID == nil)
		guard let removed else { return }
		#expect(await store.restoreSection(removed))
		#expect(store.sections.map(\.name) == ["Work", "Home"])
		#expect(store.section(containing: "a")?.name == "Work")
	}

	@Test("the quiet note is dismissed once and stays dismissed")
	func quietNote() async {
		let defaults = UserDefaults(suiteName: "ChatSectionsTests.\(UUID().uuidString)")!
		let prefs = TeamPreferences(defaults: defaults, actorID: "me", workspaceID: "w")
		let api = SectionsAPI(rows: [])
		await api.setViewRows(.quiet, [chat("q", days: 9)])
		let store = ConversationsStore(api: api, events: nil, preferences: prefs)
		await store.start()
		#expect(store.quietChatCount == 1)
		#expect(!store.quietNoteSeen)
		store.dismissQuietNote()
		#expect(store.quietNoteSeen)
		#expect(TeamPreferences(defaults: defaults, actorID: "me", workspaceID: "w").quietNoteSeen)
	}
}
