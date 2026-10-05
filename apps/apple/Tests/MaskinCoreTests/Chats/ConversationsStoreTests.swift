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
	@Test("pinned, today, yesterday, weekday names, last week, then months; empty groups dropped")
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
		let weekday = cal.weekdaySymbols[cal.component(.weekday, from: ago(days: 5)) - 1]
		let month = cal.monthSymbols[cal.component(.month, from: ago(days: 40)) - 1]
		#expect(groups.map(\.label) == ["Pinned", "Today", "Yesterday", weekday, "Last week", month])
		#expect(
			groups.map { $0.items.map(\.id) } == [["pin"], ["today"], ["yday"], ["wk"], ["last"], ["old"]])
	}

	@Test("each day inside the past week is its own group")
	func separateDays() {
		let groups = ConversationGrouping.group(
			[chatConvo("a", last: ago(days: 3)), chatConvo("b", last: ago(days: 4))], now: now, calendar: cal)
		#expect(groups.count == 2)
	}

	@Test("6 days back is still a weekday, 7 is last week, 14 falls into a month")
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
