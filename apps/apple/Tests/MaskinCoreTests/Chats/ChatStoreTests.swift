import Foundation
import Testing

@testable import MaskinCore

@MainActor
private func makeStore(
	_ api: FakeChatAPI, events: EventHub? = nil, pageSize: Int = 50,
	now: @escaping @Sendable () -> Date = { chatT0 }
) -> ChatStore {
	ChatStore(
		conversationID: "c1", currentActorID: "me", currentActorName: "Me", api: api, events: events,
		pageSize: pageSize, now: now, makeKey: { "key-1" })
}

@Suite("ChatStore")
@MainActor
struct ChatStoreTests {
	@Test("loads the newest page oldest-first and pages earlier history in")
	func paging() async {
		let api = FakeChatAPI(server: (1...7).map { chatMsg($0) })
		let store = makeStore(api, pageSize: 3)
		await store.load()
		#expect(store.messages.compactMap(\.serverID) == [5, 6, 7])
		#expect(store.hasEarlier)
		await store.loadEarlier()
		#expect(store.messages.compactMap(\.serverID) == [2, 3, 4, 5, 6, 7])
		await store.loadEarlier()
		#expect(store.messages.compactMap(\.serverID) == Array(1...7))
		#expect(!store.hasEarlier)
	}

	@Test("an optimistic message appears at once and keeps its id when confirmed")
	func optimisticSend() async {
		let api = FakeChatAPI(server: [chatMsg(1, by: "relay", agent: true)])
		let store = makeStore(api)
		await store.load()
		let id = store.send("  hello  ")
		#expect(id != nil)
		#expect(store.messages.last?.status == .sending)
		#expect(store.messages.last?.content == "hello")
		await store.deliver(id!)
		let last = store.messages.last
		#expect(last?.id == id)
		#expect(last?.serverID == 2)
		#expect(last?.status == .sent)
		#expect(store.messages.count == 2)
		#expect(await api.sentKeys == ["key-1"])
	}

	@Test("blank text is not sent")
	func blank() {
		let store = makeStore(FakeChatAPI())
		#expect(store.send("   \n") == nil)
		#expect(store.messages.isEmpty)
	}

	@Test("a failed send is marked failed and retry reuses the same idempotency key")
	func retryReusesKey() async {
		let api = FakeChatAPI()
		await api.setSendFailures(1)
		let store = makeStore(api)
		await store.load()
		let id = store.send("hello")!
		await store.deliver(id)
		#expect(store.messages.last?.isFailed == true)
		store.retrySend(id)
		#expect(store.messages.last?.status == .sending)
		await store.deliver(id)
		#expect(store.messages.count == 1)
		#expect(store.messages.last?.status == .sent)
		#expect(await api.sentKeys == ["key-1", "key-1"])
	}

	@Test("discarding removes a message that never reached the server")
	func discard() async {
		let api = FakeChatAPI()
		await api.setSendFailures(1)
		let store = makeStore(api)
		let id = store.send("hello")!
		await store.deliver(id)
		store.discard(id)
		#expect(store.messages.isEmpty)
	}

	@Test("an event refetch that beats the POST response doesn't duplicate the message")
	func eventBeatsResponse() async {
		let api = FakeChatAPI()
		let store = makeStore(api)
		await store.load()
		await api.setAfterSend { await store.sync() }
		let id = store.send("hello")!
		await store.deliver(id)
		#expect(store.messages.count == 1)
		#expect(store.messages.first?.serverID == 1)
		#expect(store.messages.first?.status == .sent)
	}

	@Test("messages stay ordered by id however they arrive")
	func outOfOrder() {
		let store = makeStore(FakeChatAPI())
		store.merge([chatMsg(5), chatMsg(3)])
		store.merge([chatMsg(4), chatMsg(3)])
		#expect(store.messages.compactMap(\.serverID) == [3, 4, 5])
	}

	@Test("a message being sent stays below confirmed messages that arrive meanwhile")
	func pendingStaysLast() async {
		let api = FakeChatAPI()
		await api.setSendFailures(1)
		let store = makeStore(api)
		let id = store.send("mine")!
		await store.deliver(id)
		store.merge([chatMsg(9, by: "relay", agent: true)])
		#expect(store.messages.map(\.id).last == id)
		#expect(store.messages.first?.serverID == 9)
	}

	@Test("an edited agent message updates in place without moving or re-keying")
	func streamingMerge() async {
		let api = FakeChatAPI(server: [chatMsg(1), chatMsg(2, by: "relay", agent: true, "Working on it")])
		let store = makeStore(api)
		await store.load()
		let idBefore = store.messages.last?.id
		await api.replace(chatMsg(2, by: "relay", agent: true, "Working on it. Done: 3 bets triaged."))
		await store.sync(full: true)
		#expect(store.messages.count == 2)
		#expect(store.messages.last?.content == "Working on it. Done: 3 bets triaged.")
		#expect(store.messages.last?.id == idBefore)
	}

	@Test("incremental sync asks only for messages after the newest known")
	func incrementalSync() async {
		let api = FakeChatAPI(server: [chatMsg(1), chatMsg(2)])
		let store = makeStore(api)
		await store.load()
		await api.append(chatMsg(3, by: "relay", agent: true))
		await store.sync()
		#expect(store.messages.compactMap(\.serverID) == [1, 2, 3])
		#expect(await api.messageCalls.last?.after == 2)
	}

	@Test("working agents appear after a send and clear when a reply lands")
	func workingIndicator() async {
		let api = FakeChatAPI(detail: chatConvo("c1", participants: [chatMe, chatRelay, chatSam]))
		let store = makeStore(api)
		await store.load()
		#expect(store.workingAgents().isEmpty)
		let id = store.send("ping")!
		await store.deliver(id)
		#expect(store.workingAgents().map(\.id) == ["relay"])
		await api.append(chatMsg(5, by: "relay", agent: true, "pong"))
		await store.sync()
		#expect(store.workingAgents().isEmpty)
	}

	@Test("the working indicator expires if no reply ever comes")
	func workingExpires() async {
		let api = FakeChatAPI(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		let store = makeStore(api)
		await store.load()
		await store.deliver(store.send("ping")!)
		#expect(!store.workingAgents(at: chatT0.addingTimeInterval(60)).isEmpty)
		#expect(store.workingAgents(at: chatT0.addingTimeInterval(600)).isEmpty)
	}

	@Test("a running agent shows as working without a recent send")
	func runningAgent() async {
		let api = FakeChatAPI(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await api.setActors([ChatActor(participant: chatRelay, agentState: .running)])
		let store = makeStore(api)
		await store.load()
		#expect(store.workingAgents().map(\.id) == ["relay"])
	}

	@Test("read cursor advances to the newest message, once, and never while inactive")
	func markRead() async {
		let api = FakeChatAPI(server: [chatMsg(1), chatMsg(2)])
		let store = makeStore(api)
		var told: [Int] = []
		store.onMarkedRead = { _, last in told.append(last) }
		store.isActive = false
		await store.load()
		#expect(await api.readCalls.isEmpty)
		store.isActive = true
		#expect(await eventually { await api.readCalls == [2] })
		await store.markReadIfNeeded()
		#expect(await api.readCalls == [2])
		await api.append(chatMsg(3))
		await store.sync()
		#expect(await api.readCalls == [2, 3])
		#expect(told == [2, 3])
	}

	@Test("an already-read thread doesn't call the server again")
	func alreadyRead() async {
		let api = FakeChatAPI(server: [chatMsg(1), chatMsg(2)], detail: chatConvo("c1", lastRead: 2))
		let store = makeStore(api)
		await store.load()
		#expect(await api.readCalls.isEmpty)
	}

	@Test("retrying an agent error reply targets the human message before it")
	func retryAgentReply() async {
		let failed = chatMsg(
			4, by: "relay", agent: true, "Model error",
			metadata: .object(["final_output": .object(["is_error": .bool(true)])]))
		let api = FakeChatAPI(server: [chatMsg(1, by: "me"), chatMsg(2, by: "relay", agent: true), chatMsg(3, by: "me"), failed])
		let store = makeStore(api)
		await store.load()
		let reply = store.messages.last!
		#expect(reply.isErrorReply)
		await store.retryAgent(for: reply)
		let call = await api.retried.first
		#expect(call?.0 == 3)
		#expect(call?.1 == "relay")
	}

	@Test("a conversation event for this chat pulls the new message in live")
	func liveEvent() async {
		let api = FakeChatAPI(server: [chatMsg(1)])
		let hub = scriptedHub([conversationFrame(10, conversation: "c1")])
		let store = makeStore(api, events: hub)
		await store.load()
		await api.append(chatMsg(2, by: "relay", agent: true, "streamed in"))
		await store.start()
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.messages.count == 2 })
		#expect(store.messages.last?.content == "streamed in")
		store.stop()
	}

	@Test("events for other conversations trigger no incremental sync")
	func otherConversation() async {
		let api = FakeChatAPI(server: [chatMsg(1)])
		let hub = scriptedHub([conversationFrame(10, conversation: "other")])
		let store = makeStore(api, events: hub)
		await store.start()
		hub.connect(workspaceId: "w1")
		// The scripted stream drops once, which reloads in full; an event for this chat would
		// instead ask for `after_id`.
		try? await Task.sleep(for: .milliseconds(200))
		#expect(await api.messageCalls.allSatisfy { $0.after == nil })
		store.stop()
	}
}
