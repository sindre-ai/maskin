import Foundation
import Testing

@testable import MaskinCore

private var cal: Calendar {
	var c = Calendar(identifier: .gregorian)
	c.timeZone = TimeZone(secondsFromGMT: 0)!
	return c
}

/// Noon UTC on a fixed Wednesday.
private let now = Date(timeIntervalSince1970: Double(1_790_000_000 - 1_790_000_000 % 86_400 + 12 * 3600))

private func ago(days: Double, hours: Double = 0) -> Date {
	now.addingTimeInterval(-days * 86_400 - hours * 3600)
}

@Suite("ConversationGrouping")
struct ConversationGroupingTests {
	@Test("pinned, today, yesterday, this week, last week, then months; empty groups dropped")
	func buckets() {
		let items = [
			chatConvo("old", last: ago(days: 40)),
			chatConvo("today", last: ago(days: 0, hours: 2)),
			chatConvo("pin", last: ago(days: 40), pinned: true),
			chatConvo("yday", last: ago(days: 1)),
			chatConvo("wk", last: ago(days: 5)),
			chatConvo("last", last: ago(days: 9)),
		]
		let groups = ConversationGrouping.group(items, now: now, calendar: cal)
		let month = cal.monthSymbols[cal.component(.month, from: ago(days: 40)) - 1]
		#expect(groups.map(\.label) == ["Pinned", "Today", "Yesterday", "This week", "Last week", month])
		#expect(
			groups.map { $0.items.map(\.id) } == [["pin"], ["today"], ["yday"], ["wk"], ["last"], ["old"]])
	}

	@Test("days inside the past week share one This week group")
	func separateDays() {
		let groups = ConversationGrouping.group(
			[chatConvo("a", last: ago(days: 3)), chatConvo("b", last: ago(days: 4))], now: now, calendar: cal)
		#expect(groups.count == 1)
		#expect(groups[0].label == "This week")
	}

	@Test("6 days back is still this week, 7 is last week, 14 falls into a month")
	func boundary() {
		let groups = ConversationGrouping.group(
			[
				chatConvo("a", last: ago(days: 6)), chatConvo("b", last: ago(days: 7)),
				chatConvo("c", last: ago(days: 14)),
			], now: now, calendar: cal)
		#expect(groups.map { $0.items.map(\.id) } == [["a"], ["b"], ["c"]])
		#expect(groups[1].label == "Last week")
	}

	@Test("most recent first inside a bucket, and undated rows land in Earlier")
	func ordering() {
		let items = [
			chatConvo("a", last: ago(days: 0, hours: 5)), chatConvo("b", last: ago(days: 0, hours: 1)),
			ConversationSummary(id: "none", title: "No date"),
		]
		let groups = ConversationGrouping.group(items, now: now, calendar: cal)
		#expect(groups[0].items.map(\.id) == ["b", "a"])
		#expect(groups[1].label == "Earlier")
		#expect(groups[1].items.map(\.id) == ["none"])
	}

	@Test("search matches title, snippet and participant names")
	func search() {
		let items = [
			chatConvo("a", title: "Roadmap"), chatConvo("b", snippet: "shipping the roadmap"),
			chatConvo("c", participants: [chatMe, ChatParticipant(id: "z", name: "Roadie", kind: .agent)]),
			chatConvo("d", title: "Other"),
		]
		#expect(ConversationGrouping.filter(items, query: "roadm").map(\.id) == ["a", "b"])
		#expect(ConversationGrouping.filter(items, query: "ROAD").map(\.id) == ["a", "b", "c"])
		#expect(ConversationGrouping.filter(items, query: "  ").count == 4)
	}
}

@Suite("ThreadLayout")
struct ThreadLayoutTests {
	@Test("inserts day separators and collapses a run of one author")
	func runs() {
		let day = 86_400.0
		let messages = [
			chatMsg(1, by: "me", at: 0), chatMsg(2, by: "me", at: 30), chatMsg(3, by: "relay", agent: true, at: 60),
			chatMsg(4, by: "relay", agent: true, at: 60 + 600), chatMsg(5, by: "relay", agent: true, at: day * 2),
		]
		let items = ThreadLayout.items(for: messages, calendar: cal)
		var kinds: [String] = []
		for item in items {
			switch item {
			case .daySeparator: kinds.append("day")
			case .system: kinds.append("sys")
			case .unreadDivider: kinds.append("new")
			case .handoff: kinds.append("handoff")
			case .liveCall: kinds.append("call")
case .message(let m, let author): kinds.append("\(m.serverID!)\(author ? "+" : "-")")
			}
		}
		#expect(kinds == ["day", "1+", "2-", "3+", "4+", "day", "5+"])
	}

	@Test("default title lists the first names")
	func title() {
		#expect(ThreadLayout.defaultTitle(for: ["A", "B"]) == "A, B")
		#expect(ThreadLayout.defaultTitle(for: ["A", "B", "C", "D", "E"]) == "A, B, C +2")
		#expect(ThreadLayout.defaultTitle(for: []) == "New chat")
	}
}

@Suite("ConversationsStore")
@MainActor
struct ConversationsStoreTests {
	@Test("refresh loads the list and exposes unread totals")
	func refresh() async {
		let api = FakeListAPI([chatConvo("a", unread: 2), chatConvo("b"), chatConvo("c", unread: 1)])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.phase == .loaded)
		#expect(store.conversations.count == 3)
		#expect(store.totalUnread == 3)
	}

	@Test("pinning is optimistic and rolls back when the server refuses")
	func pinRollback() async {
		let api = FakeListAPI([chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await store.setPinned("a", true)
		#expect(store.conversation(id: "a")?.pinned == true)
		#expect(await api.stateCalls == ["a pinned=true archived=- read=- unread=false"])
		await api.setFailState(true)
		await store.setPinned("a", false)
		#expect(store.conversation(id: "a")?.pinned == true)
		#expect(store.notice == "nope")
	}

	@Test("an agent filter clears when that agent is no longer in the list")
	func agentFilterClears() async {
		let scribe = ChatParticipant(id: "scribe", name: "Scribe", kind: .agent)
		let api = FakeListAPI([
			chatConvo("a"), chatConvo("b", participants: [chatMe, scribe]),
		])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		store.agentFilterID = "scribe"
		await store.refresh()
		#expect(store.agentFilterID == "scribe")  // still present: kept
		await store.setArchived("b", true)  // its only conversation leaves the list
		#expect(store.agentFilterID == nil)
		store.agentFilterID = "relay"
		await api.set([chatConvo("z", participants: [chatMe])])  // relay no longer in any chat
		await store.refresh()
		#expect(store.agentFilterID == nil)
	}

	@Test("archiving removes the row, and restores it if the request fails")
	func archive() async {
		let api = FakeListAPI([chatConvo("a"), chatConvo("b")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await store.setArchived("a", true)
		#expect(store.conversations.map(\.id) == ["b"])
		await api.setFailState(true)
		await store.setArchived("b", true)
		#expect(store.conversations.map(\.id) == ["b"])
	}

	@Test("bulk archive removes every picked chat, one write each")
	func bulkArchive() async {
		let api = FakeListAPI([chatConvo("a"), chatConvo("b"), chatConvo("c")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		let result = await store.setArchived(["a", "c"], true)
		#expect(result == BulkResult(succeeded: 2, failed: 0))
		#expect(store.conversations.map(\.id) == ["b"])
		let calls = await api.stateCalls
		#expect(calls.count == 2)
		#expect(store.notice == nil)
	}

	@Test("bulk archive rolls each chat back and says so when the writes fail")
	func bulkArchiveFails() async {
		let api = FakeListAPI([chatConvo("a"), chatConvo("b")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await api.setFailState(true)
		let result = await store.setArchived(["a", "b"], true)
		#expect(result == BulkResult(succeeded: 0, failed: 2))
		#expect(store.conversations.map(\.id) == ["a", "b"])
		#expect(store.notice == "Couldn't archive 2 chats.")
	}

	@Test("bulk pin pins each picked chat")
	func bulkPin() async {
		let api = FakeListAPI([chatConvo("a"), chatConvo("b")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await store.setPinned(["a", "b"], true)
		#expect(store.conversations.allSatisfy { $0.pinned })
	}

	@Test("mark unread raises the badge; reading clears it")
	func unreadState() async {
		let api = FakeListAPI([chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await store.markUnread("a")
		#expect(store.conversation(id: "a")?.unreadCount == 1)
		await store.markRead("a", upTo: 9)
		#expect(store.conversation(id: "a")?.unreadCount == 0)
		#expect(await api.stateCalls.last == "a pinned=- archived=- read=9 unread=false")
	}

	@Test("a thread that already told the server only clears the local badge")
	func localRead() async {
		let api = FakeListAPI([chatConvo("a", unread: 3)])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await store.markRead("a", serverAlreadyKnows: true)
		#expect(store.conversation(id: "a")?.unreadCount == 0)
		#expect(await api.stateCalls.isEmpty)
	}

	@Test("creating a conversation puts it first and sends participants")
	func create() async throws {
		let api = FakeListAPI([chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		let created = try await store.create(title: " Plan ", participantIDs: ["relay"], firstMessage: "  ")
		#expect(store.conversations.first?.id == created.id)
		let call = await api.created.first
		#expect(call?.0 == "Plan")
		#expect(call?.1 == ["relay"])
		#expect(call?.2 == nil)
	}

	@Test("loadMore appends the next page without duplicates")
	func loadMore() async {
		let api = FakeListAPI((1...40).map { chatConvo("c\($0)") })
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.conversations.count == 30)
		#expect(store.hasMore)
		await store.loadMore()
		#expect(store.conversations.count == 40)
		#expect(!store.hasMore)
	}

	@Test("a search query collapses into one results group")
	func searchGroup() async {
		let api = FakeListAPI([chatConvo("a", title: "Roadmap"), chatConvo("b", title: "Other")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		let groups = store.groups(query: "road")
		#expect(groups.count == 1)
		#expect(groups[0].label == "1 result")
	}

	@Test("a conversation event reloads the list")
	func liveReload() async {
		let api = FakeListAPI([chatConvo("a")])
		let hub = scriptedHub([conversationFrame(1, conversation: "a")])
		let store = ConversationsStore(api: api, events: hub)
		await store.start()
		await api.set([chatConvo("a"), chatConvo("b")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.conversations.count == 2 })
		store.stop()
	}

	@Test("the list reloads after the stream reconnects")
	func reconnectReload() async {
		let api = FakeListAPI([chatConvo("a")])
		// First body ends (a drop), the hub reconnects and broadcasts .reconnected.
		let hub = scriptedHub(["id: 1\nevent: x\ndata: {\"entity_type\":\"object\",\"workspace_id\":\"w1\",\"event_id\":\"1\"}\n\n", ""])
		let store = ConversationsStore(api: api, events: hub)
		await store.start()
		await api.set([chatConvo("a"), chatConvo("b"), chatConvo("c")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.conversations.count == 3 })
		store.stop()
	}

	@Test("overlapping refreshes coalesce into a trailing reload")
	func coalesce() async {
		let api = FakeListAPI([chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		async let r1: Void = store.refresh()
		async let r2: Void = store.refresh()
		async let r3: Void = store.refresh()
		_ = await (r1, r2, r3)
		#expect(await api.listCalls <= 3)
		#expect(store.phase == .loaded)
	}

	@Test("refresh keeps paged-in rows and never exceeds the server cap")
	func refreshKeepsPagedRows() async {
		let items = (0..<250).map { chatConvo("c\($0)") }
		let api = FakeListAPI(items)
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		for _ in 0..<6 { await store.loadMore() }
		#expect(store.conversations.count == 210)
		await store.refresh()
		#expect(await api.listLimits.allSatisfy { $0 <= ServerLimits.maxPageSize })
		#expect(store.conversations.map(\.id) == items.prefix(210).map(\.id))
		#expect(store.hasMore)
		#expect(store.phase == .loaded)
	}

	@Test("refresh re-reads as many rows as are on screen when under the cap")
	func refreshRereadsLoadedCount() async {
		let items = (0..<90).map { chatConvo("c\($0)") }
		let api = FakeListAPI(items)
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await store.loadMore()
		await store.loadMore()
		#expect(store.conversations.count == 90)
		await store.refresh()
		#expect(await api.listLimits.last == 90)
		#expect(store.conversations.count == 90)
	}
}

@Suite("ServerLimits")
struct ServerLimitsTests {
	@Test("fetchAll pages actors at the cap instead of one oversized request")
	func fetchAllPages() async throws {
		var requested: [(Int, Int)] = []
		let rows = try await ServerLimits.fetchAll { limit, offset -> [Int] in
			requested.append((limit, offset))
			return Array((offset..<min(offset + limit, 230)))
		}
		#expect(rows.count == 230)
		#expect(requested.map(\.0).allSatisfy { $0 <= ServerLimits.maxPageSize })
		#expect(requested.map(\.1) == [0, 100, 200])
	}

	@Test("chunks split ids into groups no larger than the cap")
	func chunking() {
		let chunks = ServerLimits.chunks(Array(0..<250))
		#expect(chunks.map(\.count) == [100, 100, 50])
		#expect(ServerLimits.chunks([Int]()).isEmpty)
	}

	@Test("refreshLimit clamps to the cap and floors at the page size")
	func refreshLimit() {
		#expect(ServerLimits.refreshLimit(minimum: 50, loaded: 10) == 50)
		#expect(ServerLimits.refreshLimit(minimum: 50, loaded: 80) == 80)
		#expect(ServerLimits.refreshLimit(minimum: 50, loaded: 500) == 100)
	}
}

// MARK: - Team list state (spec 7 §6)

/// A list API that keeps active and archived rows apart, like the server does.
private actor TeamFakeAPI: ConversationsAPI, ConversationDeleting {
	var active: [ConversationSummary]
	var archived: [ConversationSummary]
	var actorList: [ChatActor] = []
	var failState = false
	var failDelete = false
	var deleted: [String] = []
	var stateCalls: [String] = []

	init(active: [ConversationSummary], archived: [ConversationSummary] = []) {
		self.active = active
		self.archived = archived
	}

	func set(active: [ConversationSummary]) { self.active = active }
	func set(actors: [ChatActor]) { actorList = actors }
	func setFailState(_ v: Bool) { failState = v }
	func setFailDelete(_ v: Bool) { failDelete = v }

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws -> ConversationPage {
		let rows = archived ? self.archived : active
		return ConversationPage(conversations: Array(rows.dropFirst(offset).prefix(limit)), hasMore: false)
	}

	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String) async throws -> ConversationSummary {
		chatConvo("new", title: title)
	}

	func updateState(conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool) async throws {
		if failState { throw ChatsError("nope") }
		stateCalls.append("\(conversationID) pinned=\(pinned.map(String.init) ?? "-") archived=\(archived.map(String.init) ?? "-") read=\(lastReadMessageID.map(String.init) ?? "-") unread=\(markUnread)")
		if let archived {
			if archived, let i = active.firstIndex(where: { $0.id == conversationID }) {
				var row = active.remove(at: i)
				row.archived = true
				self.archived.insert(row, at: 0)
			} else if !archived, let i = self.archived.firstIndex(where: { $0.id == conversationID }) {
				var row = self.archived.remove(at: i)
				row.archived = false
				active.insert(row, at: 0)
			}
		}
	}

	func actors() async throws -> [ChatActor] { actorList }
	func latestMessageID(conversationID: String) async throws -> Int? { 100 }

	func delete(conversationID: String) async throws {
		if failDelete { throw ChatsError("no delete") }
		deleted.append(conversationID)
		active.removeAll { $0.id == conversationID }
		archived.removeAll { $0.id == conversationID }
	}
}

private func freshDefaults() -> UserDefaults {
	UserDefaults(suiteName: "ConversationsStoreTeamTests.\(UUID().uuidString)")!
}

private struct FixedFlows: FlowRoomsSource {
	let rooms: [TeamFlowRoom]
	init(_ rooms: [TeamFlowRoom]) { self.rooms = rooms }
	func flowRooms() async throws -> [TeamFlowRoom] { rooms }
}

private extension TeamLayout {
	func section(_ id: String) -> TeamLayout.Section? { sections.first { $0.id == id } }
}

@Suite("ConversationsStore Team list")
@MainActor
struct ConversationsStoreTeamTests {
	@Test("start loads the archived list too; archive moves a row across and unarchive brings it back")
	func archiveRoundTrip() async {
		let api = TeamFakeAPI(active: [chatConvo("a"), chatConvo("b")], archived: [chatConvo("z")])
		let store = ConversationsStore(api: api, events: nil)
		await store.start()
		#expect(store.archivedConversations.map(\.id) == ["z"])
		await store.setArchived("a", true)
		#expect(store.conversations.map(\.id) == ["b"])
		#expect(store.archivedConversations.map(\.id) == ["a", "z"])
		#expect(store.archivedConversations.first?.archived == true)
		await store.setArchived("z", false)
		#expect(store.conversations.map(\.id) == ["z", "b"])
		#expect(store.archivedConversations.map(\.id) == ["a"])
		#expect(await api.stateCalls == ["a pinned=- archived=true read=- unread=false", "z pinned=- archived=false read=- unread=false"])
	}

	@Test("a refused archive puts both lists back the way they were")
	func archiveRollback() async {
		let api = TeamFakeAPI(active: [chatConvo("a")], archived: [chatConvo("z")])
		let store = ConversationsStore(api: api, events: nil)
		await store.start()
		await api.setFailState(true)
		await store.setArchived("a", true)
		#expect(store.conversations.map(\.id) == ["a"])
		#expect(store.archivedConversations.map(\.id) == ["z"])
		#expect(store.notice == "nope")
	}

	@Test("delete removes the row, asks a source that can delete, and stays hidden through a refresh")
	func delete() async {
		let api = TeamFakeAPI(active: [chatConvo("a"), chatConvo("b")])
		let store = ConversationsStore(api: api, events: nil)
		await store.start()
		await store.delete("a")
		#expect(store.conversations.map(\.id) == ["b"])
		#expect(await api.deleted == ["a"])
		// A source that lags behind still can't bring the row back.
		await api.set(active: [chatConvo("a"), chatConvo("b")])
		await store.refresh()
		#expect(store.conversations.map(\.id) == ["b"])
	}

	@Test("a refused delete restores the row")
	func deleteRollback() async {
		let api = TeamFakeAPI(active: [chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.start()
		await api.setFailDelete(true)
		await store.delete("a")
		#expect(store.conversations.map(\.id) == ["a"])
		#expect(store.notice == "no delete")
	}

	@Test("a source without delete still drops the row locally (the stub path)")
	func deleteStub() async {
		let api = FakeListAPI([chatConvo("a"), chatConvo("b")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await store.delete("b")
		#expect(store.conversations.map(\.id) == ["a"])
		await store.refresh()
		#expect(store.conversations.map(\.id) == ["a"])
		#expect(store.notice == nil)
	}

	@Test("pin order follows pins, drag reorders it, and it persists per user")
	func pinOrder() async {
		let defaults = freshDefaults()
		let prefs = TeamPreferences(defaults: defaults, actorID: "me", workspaceID: "w")
		let api = TeamFakeAPI(active: [chatConvo("a"), chatConvo("b"), chatConvo("c")])
		let store = ConversationsStore(api: api, events: nil, preferences: prefs)
		await store.start()
		await store.setPinned("a", true)
		await store.setPinned("b", true)
		#expect(store.pinOrder == ["a", "b"])
		store.setFlowPinned("f", true)
		#expect(store.pinOrder == ["a", "b", "flow:f"])
		#expect(store.pinnedFlowIDs == ["f"])
		store.movePin("flow:f", before: "a", tiles: ["a", "b", "flow:f"])
		#expect(store.pinOrder == ["flow:f", "a", "b"])
		await store.setPinned("a", false)
		#expect(store.pinOrder == ["flow:f", "b"])
		store.setFlowPinned("f", false)
		#expect(store.pinOrder == ["b"])
		#expect(prefs.pinOrder == ["b"])
		#expect(prefs.pinnedFlowIDs.isEmpty)

		let again = ConversationsStore(api: api, events: nil, preferences: TeamPreferences(defaults: defaults, actorID: "me", workspaceID: "w"))
		#expect(again.pinOrder == ["b"])
	}

	@Test("a refused pin leaves the order alone")
	func pinOrderRollback() async {
		let api = TeamFakeAPI(active: [chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.start()
		await api.setFailState(true)
		await store.setPinned("a", true)
		#expect(store.pinOrder.isEmpty)
		#expect(store.conversation(id: "a")?.pinned == false)
	}

	@Test("display options persist; hiding the chips resets the chip and the layout ignores it")
	func displayOptions() async {
		let defaults = freshDefaults()
		let api = TeamFakeAPI(active: [chatConvo("a", unread: 1), chatConvo("b")])
		let store = ConversationsStore(
			api: api, events: nil, preferences: TeamPreferences(defaults: defaults, actorID: "me", workspaceID: "w"))
		await store.start()
		#expect(store.displayOptions == .default)
		store.displayOptions.showsFilterChips = true
		store.chip = .unread
		#expect(store.layout(currentActorID: "me").sections.map(\.id) == ["unread"])
		store.displayOptions.showsFilterChips = false
		#expect(store.chip == .all)
		store.displayOptions.layout = .oneList
		#expect(store.layout(currentActorID: "me").sections.map(\.id) == ["all"])
		let again = ConversationsStore(api: api, events: nil, preferences: TeamPreferences(defaults: defaults, actorID: "me", workspaceID: "w"))
		#expect(again.displayOptions.layout == .oneList)
	}

	@Test("working agents come from the actor list and show on rows and flows")
	func working() async {
		let api = TeamFakeAPI(active: [chatConvo("a", snippet: "On it", participants: [chatMe, chatRelay])])
		await api.set(actors: [ChatActor(participant: chatRelay, agentState: .running), ChatActor(participant: chatSam)])
		let source = FixedFlows([TeamFlowRoom(id: "f", name: "Launch", loop: LoopSummary(id: "f", name: "Launch", agentIDs: ["relay"]))])
		let store = ConversationsStore(api: api, events: nil, flowRooms: source)
		await store.start()
		#expect(store.workingAgentIDs == ["relay"])
		#expect(store.status(for: store.conversations[0]).prefix == .working(1))
		let layout = store.layout(currentActorID: "me")
		guard case .flow(let room)? = layout.section("flows")?.rows.first?.kind else {
			Issue.record("no flow row")
			return
		}
		#expect(room.workingCount == 1)
		store.typingConversationIDs = ["a"]
		#expect(store.status(for: store.conversations[0]).prefix == .typing)
	}

	@Test("flow rooms load from the source and the archived list is part of the layout")
	func flowsAndArchived() async {
		let api = TeamFakeAPI(active: [chatConvo("a")], archived: [chatConvo("z")])
		let store = ConversationsStore(api: api, events: nil, flowRooms: FixedFlows([TeamFlowRoom(id: "f", name: "Launch")]))
		await store.start()
		let layout = store.layout(currentActorID: "me")
		#expect(layout.section("flows")?.rows.map(\.id) == ["flow:f"])
		#expect(layout.showsArchived)
		#expect(layout.archivedCount == 1)
	}

	@Test("the unread section's ids feed Mark all read, which records the newest message per chat")
	func markAllReadFromLayout() async {
		let api = TeamFakeAPI(active: [chatConvo("u1", unread: 2), chatConvo("u2", unread: 1), chatConvo("r")])
		let store = ConversationsStore(api: api, events: nil)
		await store.start()
		let ids = store.layout(currentActorID: "me").section("unread")?.unreadConversationIDs ?? []
		#expect(Set(ids) == ["u1", "u2"])
		await store.markRead(ids)
		#expect(store.totalUnread == 0)
		#expect(await api.stateCalls.allSatisfy { $0.contains("read=100") })
	}
}
