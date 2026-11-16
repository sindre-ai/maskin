import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private var cal: Calendar {
	var c = Calendar(identifier: .gregorian)
	c.timeZone = TimeZone(secondsFromGMT: 0)!
	return c
}

/// Noon UTC on a fixed day.
private let now = Date(timeIntervalSince1970: Double(1_790_000_000 - 1_790_000_000 % 86_400 + 12 * 3600))

private func ago(hours: Double) -> Date { now.addingTimeInterval(-hours * 3600) }

private func chat(
	_ id: String, hours: Double = 1, pinned: Bool = false, unread: Int = 0, needsYou: Bool = false,
	working: Bool = false, later: Bool = false, stop: ChatStopReason? = nil, tags: [String] = [],
	participants: [ChatParticipant] = [chatMe, chatRelay], direct: Bool = false
) -> ConversationSummary {
	var c = chatConvo(id, last: ago(hours: hours), pinned: pinned, unread: unread, participants: participants)
	c.needsYou = needsYou
	c.working = working ? [ChatWorkingAgent(agentID: "relay", sessionID: "s-\(id)")] : []
	c.later = later
	c.stopReason = stop
	c.retryMessageID = stop == nil ? nil : 9
	c.tags = tags
	c.directPairKey = direct ? "me:relay" : nil
	return c
}

private func ids(_ groups: [ChatListGroup]) -> [[String]] { groups.map { $0.items.map(\.id) } }

@Suite("Chat list markers")
struct ChatListMarkerTests {
	@Test("one marker per row, in the order error, needs you, working")
	func order() {
		#expect(chat("a", needsYou: true, working: true, stop: .usageLimit).previewMarker == .error(.usageLimit))
		#expect(chat("b", needsYou: true, working: true).previewMarker == .needsYou)
		#expect(chat("c", working: true).previewMarker == .working)
		#expect(chat("d", unread: 3).previewMarker == nil)
	}

	@Test("a Later row shows no marker")
	func later() {
		#expect(chat("a", needsYou: true, later: true).previewMarker == nil)
	}

	@Test("the stopped line says the reason, verbatim")
	func lines() {
		#expect(ChatStopReason.usageLimit.line == "Stopped. Usage limit reached.")
		#expect(ChatStopReason.other.line == "Stopped. Something went wrong.")
		#expect(ChatStopReason.connection.line == "Stopped. Connection dropped.")
		#expect(ChatStopReason(serverValue: "somethingNew") == .other)
		#expect(ChatStopReason(serverValue: nil) == .other)
		#expect(ChatStopReason(serverValue: "usage_limit") == .usageLimit)
	}

	@Test("the tracked marker is the preview marker, else later, else unread, else none")
	func tracked() {
		#expect(ChatListTracking.marker(of: chat("a", stop: .other)) == .error)
		#expect(ChatListTracking.marker(of: chat("b", needsYou: true)) == .needsYou)
		#expect(ChatListTracking.marker(of: chat("c", working: true)) == .working)
		#expect(ChatListTracking.marker(of: chat("d", unread: 1, later: true)) == .later)
		#expect(ChatListTracking.marker(of: chat("e", unread: 1)) == .unread)
		#expect(ChatListTracking.marker(of: chat("f")) == .none)
	}
}

@Suite("Chat list pills")
struct ChatListPillTests {
	private let rows = [
		chat("wait", needsYou: true), chat("stopped", stop: .connection), chat("run", working: true),
		chat("unread", unread: 2), chat("later", unread: 1, needsYou: true, later: true), chat("plain"),
	]

	@Test("a stopped chat counts under Needs you, a Later chat only under Later")
	func filters() {
		func pick(_ f: ChatListFilter) -> [String] { rows.filter { f.includes($0) }.map { $0.id } }
		#expect(pick(.all) == ["wait", "stopped", "run", "unread", "plain"])
		#expect(pick(.needsYou) == ["wait", "stopped"])
		#expect(pick(.unread) == ["unread"])
		#expect(pick(.working) == ["run"])
		#expect(pick(.later) == ["later"])
	}

	@Test("counts exclude All and follow the same rules")
	func counts() {
		let counts = ChatListLayout.counts(rows)
		#expect(counts[.needsYou] == 2)
		#expect(counts[.unread] == 1)
		#expect(counts[.working] == 1)
		#expect(counts[.later] == 1)
		#expect(counts[.all] == nil)
	}

	@Test("the pills and their empty copy are the addendum's")
	func copy() {
		#expect(ChatListFilter.allCases.map(\.label) == ["All", "Needs you", "Unread", "Working", "Later"])
		#expect(ChatListFilter.needsYou.emptyText == "Nothing waits on you.")
		#expect(ChatListFilter.unread.emptyText == "You are all caught up.")
		#expect(ChatListFilter.working.emptyText == "No agent is working right now.")
		#expect(ChatListFilter.all.emptyText == "No chats yet. Start one with an agent.")
		#expect(
			ChatListFilter.later.emptyText
				== "Nothing is on Later. Move a chat here to hide it until it gets a new message.")
		#expect(ChatListCopy.movedToLater == "Moved to Later. A new message brings it back.")
		#expect(ChatListCopy.markedDone == "Marked done")
	}
}

@Suite("Chat list groups")
struct ChatListGroupTests {
	private func groups(_ rows: [ConversationSummary], _ by: ChatListGroupBy, filter: ChatListFilter = .all)
		-> [ChatListGroup]
	{
		ChatListLayout.groups(rows, filter: filter, groupBy: by, currentActorID: "me", now: now, calendar: cal)
	}

	@Test("by date: Pinned, Today, Earlier, newest first, empty groups dropped")
	func date() {
		let rows = [
			chat("old", hours: 60), chat("pin", hours: 70, pinned: true), chat("new", hours: 1),
			chat("mid", hours: 5),
		]
		let result = groups(rows, .date)
		#expect(result.map(\.label) == ["Pinned", "Today", "Earlier"])
		#expect(ids(result) == [["pin"], ["new", "mid"], ["old"]])
		#expect(result.map(\.section) == [.pinned, .today, .earlier])
	}

	@Test("by status: stopped chats lead Needs you, and no chat shows twice")
	func status() {
		let rows = [
			chat("ask", hours: 1, needsYou: true), chat("err", hours: 3, stop: .usageLimit),
			chat("run", hours: 2, working: true), chat("unread", hours: 4, unread: 1),
			chat("quiet", hours: 5), chat("pin", hours: 6, pinned: true, needsYou: true),
			chat("later", hours: 1, later: true),
		]
		let result = groups(rows, .status)
		#expect(result.map(\.label) == ["Pinned", "Needs you", "Working", "Unread", "Earlier"])
		#expect(ids(result) == [["pin"], ["err", "ask"], ["run"], ["unread"], ["quiet"]])
		#expect(result.flatMap(\.items).count == Set(result.flatMap(\.items).map(\.id)).count)
	}

	@Test("by type: Direct, Topic, Group")
	func type() {
		let rows = [
			chat("dm", direct: true), chat("topic"), chat("group", participants: [chatMe, chatRelay, chatSam]),
		]
		let result = groups(rows, .type)
		#expect(result.map(\.label) == ["Direct", "Topic", "Group"])
		#expect(ids(result) == [["dm"], ["topic"], ["group"]])
		#expect(result.allSatisfy { $0.section == .type })
	}

	@Test("by agent: the names in order of first appearance, the agentless last")
	func agent() {
		let ida = ChatParticipant(id: "ida", name: "Ida", kind: .agent)
		let rows = [
			chat("a", hours: 1), chat("b", hours: 2, participants: [chatMe, ida]), chat("c", hours: 3),
			chat("d", hours: 4, participants: [chatMe, chatSam]),
		]
		let result = groups(rows, .agent)
		#expect(result.map(\.label) == ["Relay", "Ida", "Sam"])
		#expect(ids(result) == [["a", "c"], ["b"], ["d"]])
	}

	@Test("by tag: the first tag, the untagged under No tag")
	func tag() {
		let rows = [chat("a", hours: 1, tags: ["Sales", "Ops"]), chat("b", hours: 2), chat("c", hours: 3, tags: ["Ops"])]
		let result = groups(rows, .tag)
		#expect(result.map(\.label) == ["Sales", "Ops", "No tag"])
		#expect(ids(result) == [["a"], ["c"], ["b"]])
	}

	@Test("by none: one list without a heading, pinned first")
	func none() {
		let rows = [chat("a", hours: 1), chat("b", hours: 2, pinned: true)]
		let result = groups(rows, .none)
		#expect(result.count == 1)
		#expect(result[0].label.isEmpty)
		#expect(ids(result) == [["b", "a"]])
	}

	@Test("the pill narrows the list before it is grouped")
	func pill() {
		let rows = [chat("ask", needsYou: true), chat("quiet"), chat("later", later: true)]
		#expect(ids(groups(rows, .date, filter: .needsYou)) == [["ask"]])
		#expect(ids(groups(rows, .date, filter: .later)) == [["later"]])
		#expect(groups(rows, .date, filter: .working).isEmpty)
	}

	@Test("a row's place is its position on screen and its group's section")
	func place() {
		let result = groups([chat("pin", hours: 9, pinned: true), chat("a", hours: 1), chat("b", hours: 2)], .date)
		let place = ChatListLayout.place(of: "b", in: result)
		#expect(place?.position == 3)
		#expect(place?.section == .today)
		#expect(ChatListLayout.place(of: "gone", in: result) == nil)
	}
}

@Suite("Chat list search operators")
struct ChatListSearchOperatorTests {
	@Test("each operator once, in the order it first appears, never the words")
	func operators() {
		#expect(ChatListSearchOperators.used(in: "hello").isEmpty)
		#expect(ChatListSearchOperators.used(in: "@forge from:sam is:unread") == [.agent, .from, .is])
		#expect(ChatListSearchOperators.used(in: "is:unread is:later with:x team:y") == [.is, .with, .team])
		#expect(ChatListSearchOperators.used(in: "\"exact words\" -skip") == [.phrase, .exclude])
	}

	@Test("an operator with nothing after it, or an unclosed quote, is plain text")
	func plain() {
		#expect(ChatListSearchOperators.used(in: "from: is: @ -").isEmpty)
		#expect(ChatListSearchOperators.used(in: "\"never closed from:sam") == [.from])
	}
}

@Suite("Chat list events")
struct ChatListEventTests {
	@MainActor
	private final class Sink: AnalyticsSink {
		var events: [(name: String, properties: AnalyticsProperties)] = []
		func start() {}
		func identify(_ distinctId: String) {}
		func group(type: String, key: String) {}
		func capture(_ event: String, properties: AnalyticsProperties) { events.append((event, properties)) }
		func reset() {}
		func stop() {}
	}

	@MainActor
	@Test("the open carries marker, filter and group_by; the new events carry categories only")
	func events() {
		let sink = Sink()
		let analytics = Analytics()
		analytics.configure(sink: sink, storage: InMemoryAnalyticsStorage())
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.setConsent(true)
		sink.events.removeAll()

		analytics.chatOpenedFromList(
			.init(
				source: .list, section: .needsYou, position: 2, marker: .error, filter: .needsYou,
				groupBy: .status))
		analytics.chatRowAction(.retry, via: .swipe)
		analytics.chatListSearchUsed(resultCount: 3, operators: [.agent, .is])
		analytics.chatListSearchUsed(resultCount: 0)

		let opened = sink.events[0].properties
		#expect(opened["section"] == "needs_you")
		#expect(opened["marker"] == "error")
		#expect(opened["filter"] == "needs_you")
		#expect(opened["group_by"] == "status")
		#expect(opened["surface"] == "iphone")
		let action = sink.events[1]
		#expect(action.name == "chat_row_action")
		#expect(action.properties["action"] == "retry")
		#expect(action.properties["via"] == "swipe")
		#expect(sink.events[2].properties["operators"] == .strings(["agent", "is"]))
		#expect(sink.events[3].properties["operators"] == .strings(["none"]))
	}

	@MainActor
	@Test("the older places leave the new properties out")
	func older() {
		let sink = Sink()
		let analytics = Analytics()
		analytics.configure(sink: sink, storage: InMemoryAnalyticsStorage())
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.setConsent(true)
		sink.events.removeAll()
		analytics.chatOpenedFromList(.init(source: .list, section: .recent, position: 1))
		#expect(sink.events[0].properties["marker"] == nil)
		#expect(sink.events[0].properties["filter"] == nil)
		#expect(sink.events[0].properties["group_by"] == nil)
	}
}

private actor LaterFakeAPI: ConversationsAPI {
	var later: [String: Bool] = [:]
	var retries: [(String, Int, String?)] = []
	var failLater = false
	var failRetry = false
	var rows: [ConversationSummary]
	init(_ rows: [ConversationSummary]) { self.rows = rows }
	func setRows(_ r: [ConversationSummary]) { rows = r }
	func failLaterCalls() { failLater = true }
	func failRetryCalls() { failRetry = true }

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws
		-> ConversationPage
	{
		ConversationPage(conversations: rows, hasMore: false)
	}
	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String)
		async throws -> ConversationSummary
	{ chatConvo("new") }
	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool
	) async throws {}
	func actors() async throws -> [ChatActor] { [] }
	func setLater(conversationID: String, later value: Bool) async throws {
		if failLater { throw ChatsError("nope") }
		later[conversationID] = value
	}
	func retry(conversationID: String, messageID: Int, agentID: String?) async throws {
		if failRetry { throw ChatsError("nope") }
		retries.append((conversationID, messageID, agentID))
	}
}

@Suite("Chat list actions")
@MainActor
struct ChatListActionTests {
	private func store(_ rows: [ConversationSummary]) async -> (ConversationsStore, LaterFakeAPI) {
		let api = LaterFakeAPI(rows)
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		return (store, api)
	}

	@Test("Later moves the chat to the Later list, tells the server, and moves it back when that fails")
	func later() async {
		let (store, api) = await store([chat("a"), chat("b")])
		#expect(await store.setLater("a", true))
		#expect(store.conversations.map(\.id) == ["b"])
		#expect(store.laterConversations.map(\.id) == ["a"])
		#expect(store.laterConversations.first?.later == true)
		#expect(await api.later["a"] == true)
		#expect(store.chatListCounts[.later] == 1)

		// Undo takes it back to the list.
		#expect(await store.setLater("a", false))
		#expect(store.laterConversations.isEmpty)
		#expect(store.conversations.map(\.id).sorted() == ["a", "b"])

		await api.failLaterCalls()
		#expect(await store.setLater("b", true) == false)
		#expect(store.conversations.map(\.id).sorted() == ["a", "b"])
		#expect(store.laterConversations.isEmpty)
		#expect(store.notice != nil)
	}

	@Test("the Later pill shows the Later list, the others never show a Later chat")
	func laterPill() async {
		let (store, _) = await store([chat("a"), chat("b")])
		_ = await store.setLater("a", true)
		store.listFilter = .later
		#expect(ids(store.chatListGroups(currentActorID: "me", now: now)) == [["a"]])
		store.listFilter = .all
		#expect(ids(store.chatListGroups(currentActorID: "me", now: now)) == [["b"]])
	}

	@Test("Retry clears the marker at once and re-runs the last person message")
	func retry() async {
		let (store, api) = await store([chat("a", stop: .usageLimit)])
		#expect(await store.retryStopped("a"))
		#expect(store.conversation(id: "a")?.stopReason == nil)
		let calls = await api.retries
		#expect(calls.count == 1)
		#expect(calls.first?.0 == "a")
		#expect(calls.first?.1 == 9)
		#expect(calls.first?.2 == nil)
	}

	@Test("Retry that cannot be asked for brings the marker back with a notice")
	func retryFails() async {
		let (store, api) = await store([chat("a", stop: .connection)])
		await api.failRetryCalls()
		#expect(await store.retryStopped("a") == false)
		#expect(store.conversation(id: "a")?.stopReason == .connection)
		#expect(store.notice != nil)
	}

	@Test("a refresh computed before the retry cannot put the old red marker back")
	func staleRefresh() async {
		let (store, api) = await store([chat("a", stop: .usageLimit)])
		_ = await store.retryStopped("a")
		await store.refresh()
		#expect(store.conversation(id: "a")?.stopReason == nil)

		// The server now shows the chat without a marker (the retry started), then it fails again.
		await api.setRows([chat("a", working: true)])
		await store.refresh()
		await api.setRows([chat("a", stop: .other)])
		await store.refresh()
		#expect(store.conversation(id: "a")?.stopReason == .other)
	}

	@Test("Retry on a chat that has not stopped does nothing")
	func notStopped() async {
		let (store, api) = await store([chat("a")])
		#expect(await store.retryStopped("a") == false)
		#expect(await api.retries.isEmpty)
	}
}

@Suite("Thread working line")
struct ThreadWorkingLineWordsTests {
	@Test("one, two and three names read as a sentence")
	func joiners() {
		func sentence(_ names: [String]) -> String {
			names.enumerated().map { $1 + ChatWorkingLine.joiner(after: $0, of: names.count) }.joined(separator: " ")
				+ " " + ChatWorkingLine.verb(for: names.count)
		}
		#expect(sentence(["Forge"]) == "Forge is working")
		#expect(sentence(["Forge", "Sage"]) == "Forge and Sage are working")
		#expect(sentence(["Forge", "Sage", "Atlas"]) == "Forge, Sage and Atlas are working")
	}
}

@Suite("Chat list wire")
struct ChatListWireTests {
	private let json = """
		{"conversations":[
		 {"id":"c1","title":"Plan","lastMessageAt":"2026-11-16T10:00:00.000Z","createdAt":"2026-11-15T10:00:00Z",
		  "pinned":false,"archived":false,"unread_count":2,"snippet":"Which one?","snippet_actor_name":"Relay",
		  "snippet_actor_id":"relay","directPairKey":null,"tags":["Sales"],
		  "participants":[{"actorId":"me","actorName":"Me","actorType":"human"},{"actorId":"relay","actorName":"Relay","actorType":"agent"}],
		  "working":[{"agent_id":"relay","session_id":"s1"}],"needs_you":true,"later":false,"error":null},
		 {"id":"c2","title":"Stopped","lastMessageAt":null,"createdAt":null,"pinned":true,"archived":false,
		  "unread_count":0,"snippet":null,"snippet_actor_name":null,"snippet_actor_id":null,"directPairKey":"me:relay",
		  "participants":[{"actorId":"relay","actorName":"Relay","actorType":"agent"}],
		  "working":[],"needs_you":true,"later":true,"error":{"reason":"usage_limit","last_person_message_id":41}},
		 {"id":"c3","title":"Old server","lastMessageAt":null,"createdAt":null,"pinned":false,"archived":false,
		  "unread_count":0,"snippet":null,"snippet_actor_name":null,"snippet_actor_id":null,"directPairKey":null,
		  "participants":[]},
		 {"id":"c4","title":"Odd","lastMessageAt":null,"createdAt":null,"pinned":false,"archived":false,
		  "unread_count":0,"snippet":null,"snippet_actor_name":null,"snippet_actor_id":null,"directPairKey":null,
		  "participants":[],"error":{"reason":"a_new_reason","last_person_message_id":null}}
		],"has_more":true}
		"""

	@Test("the attention fields are read, and a server that predates them reads as quiet")
	func decode() throws {
		let page = try APIChatAttention.decode(Data(json.utf8))
		#expect(page.hasMore)
		let (a, b, c, d) = (page.conversations[0], page.conversations[1], page.conversations[2], page.conversations[3])
		#expect(a.needsYou && a.working == [ChatWorkingAgent(agentID: "relay", sessionID: "s1")])
		#expect(a.tags == ["Sales"] && a.unreadCount == 2 && a.stopReason == nil)
		#expect(b.stopReason == .usageLimit && b.retryMessageID == 41 && b.canRetry && b.later && b.isDirect)
		#expect(c.needsYou == false && c.working.isEmpty && c.later == false && c.stopReason == nil && c.tags.isEmpty)
		// An unknown reason reads as the generic one; with no last person message there is nothing to retry.
		#expect(d.stopReason == .other && d.retryMessageID == nil && d.canRetry == false)
	}

	@Test("a body that is not a list is refused with a plain message")
	func garbage() {
		#expect(throws: ChatsError.self) { try APIChatAttention.decode(Data("{}".utf8)) }
	}

	@Test("the list asks for Later with later=true and leaves the other flags out when off")
	func request() async throws {
		let source = APIChatAttention(
			baseURL: URL(string: "https://app.test")!, clientSource: "iphone",
			credentials: { MaskinCredentials(apiKey: "k", workspaceId: "w") })
		let get = await source.makeRequest(
			url: URL(string: "https://app.test/api/conversations?later=true&limit=30&offset=0"), method: "GET", body: nil)
		#expect(get.httpMethod == "GET")
		#expect(get.value(forHTTPHeaderField: "Authorization") == "Bearer k")
		#expect(get.value(forHTTPHeaderField: "X-Workspace-Id") == "w")
		#expect(get.value(forHTTPHeaderField: "Idempotency-Key") == nil)
		let patch = await source.makeRequest(
			url: URL(string: "https://app.test/api/conversations/c1/me"), method: "PATCH",
			body: try JSONEncoder().encode(["later": true]))
		#expect(patch.value(forHTTPHeaderField: "Idempotency-Key")?.isEmpty == false)
		#expect(patch.value(forHTTPHeaderField: "Content-Type") == "application/json")
		#expect(String(data: patch.httpBody ?? Data(), encoding: .utf8) == "{\"later\":true}")
	}
}
