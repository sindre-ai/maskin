import Foundation
import Testing

@testable import MaskinCore

private let questionMeta: JSONValue = .object([
	"question": .object([
		"session_id": .string("s1"),
		"questions": .array([
			.object([
				"question": .string("Which environment?"), "header": .string("Env"),
				"multi_select": .bool(false),
				"options": .array([
					.object(["label": .string("Staging")]),
					.object(["label": .string("Prod"), "description": .string("Live users")]),
				]),
			])
		]),
	])
])

@Suite("ChatStore")
@MainActor
struct ChatStoreTests {
	@Test("loads the newest page oldest-first and pages earlier history in")
	func paging() async {
		let h = ChatHarness(server: (1...7).map { chatMsg($0) }, pageSize: 3)
		await h.store.start()
		#expect(h.store.messages.compactMap(\.serverID) == [5, 6, 7])
		#expect(h.store.hasEarlier)
		await h.store.loadEarlier()
		#expect(h.store.messages.compactMap(\.serverID) == [2, 3, 4, 5, 6, 7])
		await h.store.loadEarlier()
		#expect(h.store.messages.compactMap(\.serverID) == Array(1...7))
		#expect(!h.store.hasEarlier)
	}

	@Test("page sizes never exceed the server's message cap")
	func pageCap() async {
		let h = ChatHarness(server: [chatMsg(1)], pageSize: 5000)
		await h.store.start()
		#expect(h.store.messages.count == 1)
		#expect(ChatLimits.maxMessagesPage == 200)
	}

	@Test("a sent message shows at once, goes out once under one key, and keeps its row id")
	func optimisticSend() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true)])
		await h.store.start()
		let id = h.store.send("  hello  ")
		#expect(id != nil)
		#expect(h.store.messages.last?.status == .sending)
		#expect(h.store.messages.last?.content == "hello")
		#expect(h.store.messages.last?.id == id)
		#expect(await h.settled())
		let last = h.store.messages.last
		#expect(last?.id == id)
		#expect(last?.serverID == 2)
		#expect(last?.status == .sent)
		#expect(h.store.messages.count == 2)
		#expect(await h.api.sentContents == ["hello"])
	}

	@Test("blank text is not sent")
	func blank() async {
		let h = ChatHarness()
		#expect(h.store.send("   \n") == nil)
		#expect(h.store.messages.isEmpty)
		#expect(h.outbox.entries.isEmpty)
	}

	@Test("a message typed offline waits, shows as sending, and goes out once when online")
	func offlineSend() async {
		let h = ChatHarness(online: false)
		await h.store.start()
		h.store.send("later")
		await h.outbox.drain()
		#expect(await h.api.sentKeys.isEmpty)
		#expect(h.store.messages.last?.status == .waiting("Waiting for a connection"))
		if case .waiting = h.queue.pending(in: "c1").first?.state {} else { Issue.record("expected waiting") }
		h.network.set(online: true)
		#expect(await h.settled())
		#expect(await h.api.sentContents == ["later"])
		#expect(await h.api.server.count == 1)
	}

	@Test("a message queued before the app was killed is sent exactly once after relaunch")
	func survivesRelaunch() async {
		let file = temporaryOutboxFile()
		let api = FakeChatAPI()
		let first = ChatHarness(online: false, file: file, api: api)
		first.store.send("survive me")
		await first.outbox.drain()
		#expect(await api.sentKeys.isEmpty)
		let key = first.outbox.entries.first?.idempotencyKey

		// Relaunch: a new outbox over the same file, now online.
		let second = ChatHarness(file: file, api: api)
		#expect(second.store.messages.map(\.content) == ["survive me"])
		await second.outbox.drain()
		#expect(await second.settled())
		#expect(await api.sentContents == ["survive me"])
		#expect(await api.sentKeys == [key])
		#expect(await api.server.count == 1)
	}

	@Test("a response lost on the way back is retried under the same key and posts once")
	func lostResponse() async {
		let h = ChatHarness()
		await h.store.start()
		await h.api.setLoseResponses(1)
		h.store.send("only once")
		#expect(await h.settled())
		let keys = await h.api.sentKeys
		#expect(keys.count == 2)
		#expect(Set(keys).count == 1, "every replay carries the original Idempotency-Key")
		#expect(await h.api.server.count == 1)
		#expect(h.store.messages.count == 1)
		#expect(h.store.messages.first?.status == .sent)
	}

	@Test("a refused send becomes a failed row; retry sends it, delete removes it")
	func refusedSend() async {
		let h = ChatHarness()
		await h.store.start()
		await h.api.failNextSends([ChatsHTTPError(status: 422, message: "Too long.")])
		let id = h.store.send("hello")!
		#expect(await eventually { h.store.messages.last?.isFailed == true })
		#expect(h.store.messages.last?.status == .failed("Too long."))
		#expect(h.store.messages.last?.id == id)
		h.store.retrySend(id)
		#expect(await h.settled())
		#expect(h.store.messages.count == 1)
		#expect(h.store.messages.last?.status == .sent)

		await h.api.failNextSends([ChatsHTTPError(status: 400, message: "Nope.")])
		let second = h.store.send("again")!
		#expect(await eventually { h.store.messages.last?.isFailed == true })
		h.store.discard(second)
		#expect(h.store.messages.count == 1)
	}

	@Test("a failed message survives a relaunch so the words are never lost")
	func failedSurvivesRelaunch() async {
		let failedFile = FileManager.default.temporaryDirectory
			.appendingPathComponent("chat-failed-\(UUID().uuidString).json")
		let first = ChatHarness(failedFile: failedFile)
		await first.api.failNextSends([ChatsHTTPError(status: 422, message: "Rejected.")])
		first.store.send("keep this")
		#expect(await eventually { first.store.messages.last?.isFailed == true })
		let second = ChatHarness(failedFile: failedFile)
		#expect(second.store.messages.last?.content == "keep this")
		#expect(second.store.messages.last?.isFailed == true)
		try? FileManager.default.removeItem(at: failedFile)
	}

	@Test("a 403 drops that message but doesn't hold the rest of the queue")
	func forbiddenDoesNotBlock() async {
		let h = ChatHarness()
		await h.api.failNextSends([ChatsHTTPError(status: 403, message: "You left this chat.")])
		h.store.send("one")
		#expect(await eventually { h.store.messages.last?.isFailed == true })
		#expect(!h.outbox.isAuthBlocked)
		h.store.send("two")
		#expect(await h.settled())
		#expect(await h.api.sentContents == ["one", "two"])
	}

	@Test("a 401 holds the queue, keeps the message, and sends it once after sign-in")
	func unauthorizedHolds() async {
		let h = ChatHarness()
		// The key stays bad for every probe until "sign-in".
		await h.api.failNextSends(Array(repeating: ChatsHTTPError(status: 401, message: "Sign in."), count: 500))
		h.store.send("held")
		#expect(await eventually { h.outbox.isAuthBlocked })
		#expect(h.outbox.entries.count == 1)
		#expect(h.queue.pending(in: "c1").first?.state == .waiting("Sign in again to send"))
		#expect(h.store.messages.last?.status == .waiting("Sign in again to send"))
		await h.api.failNextSends([])
		h.outbox.resumeAfterAuth()
		#expect(await h.settled())
		#expect(await h.api.server.count == 1)
		#expect(Set(await h.api.sentKeys).count == 1)
	}

	@Test("an event refetch that beats the POST response doesn't duplicate the message")
	func eventBeatsResponse() async {
		let h = ChatHarness()
		await h.store.start()
		let store = h.store
		await h.api.setAfterSend { await store.sync() }
		h.store.send("hello")
		#expect(await h.settled())
		#expect(h.store.messages.count == 1)
		#expect(h.store.messages.first?.serverID == 1)
		#expect(h.store.messages.first?.status == .sent)
	}

	@Test("a queued message is hidden once its server copy is in, but not by an older identical one")
	func ghostRows() async {
		let h = ChatHarness(online: false)
		h.store.merge([chatMsg(1, by: "me", "ok")])
		await h.store.start()
		h.store.send("ok")
		// Older identical message: the queued one must still show.
		#expect(h.store.messages.count == 2)
		#expect(h.store.messages.last?.status == .waiting("Waiting for a connection"))
		// Its server copy arrives (a refetch beat the replay): no ghost.
		h.store.merge([chatMsg(2, by: "me", "ok")])
		#expect(h.store.messages.compactMap(\.serverID) == [1, 2])
		#expect(h.store.messages.count == 2)
	}

	@Test("messages stay ordered by id however they arrive")
	func outOfOrder() {
		let h = ChatHarness()
		h.store.merge([chatMsg(5), chatMsg(3)])
		h.store.merge([chatMsg(4), chatMsg(3)])
		#expect(h.store.messages.compactMap(\.serverID) == [3, 4, 5])
	}

	@Test("a message being sent stays below confirmed messages that arrive meanwhile")
	func pendingStaysLast() async {
		let h = ChatHarness(online: false)
		let id = h.store.send("mine")!
		h.store.merge([chatMsg(9, by: "relay", agent: true)])
		#expect(h.store.messages.map(\.id).last == id)
		#expect(h.store.messages.first?.serverID == 9)
	}

	@Test("an edited agent message updates in place without moving or re-keying")
	func streamingMerge() async {
		let h = ChatHarness(server: [chatMsg(1), chatMsg(2, by: "relay", agent: true, "Working on it")])
		await h.store.start()
		let idBefore = h.store.messages.last?.id
		await h.api.replace(chatMsg(2, by: "relay", agent: true, "Working on it. Done: 3 bets triaged."))
		await h.store.sync(full: true)
		#expect(h.store.messages.count == 2)
		#expect(h.store.messages.last?.content == "Working on it. Done: 3 bets triaged.")
		#expect(h.store.messages.last?.id == idBefore)
	}

	@Test("incremental sync asks only for messages after the newest known")
	func incrementalSync() async {
		let h = ChatHarness(server: [chatMsg(1), chatMsg(2)])
		await h.store.start()
		await h.api.append(chatMsg(3, by: "relay", agent: true))
		await h.store.sync()
		#expect(h.store.messages.compactMap(\.serverID) == [1, 2, 3])
		#expect(await h.api.messageCalls.last?.after == 2)
	}

	@Test("more new messages than a page leave no hole: older rows drop and page back in")
	func gapAfterOffline() async {
		let h = ChatHarness(server: (1...3).map { chatMsg($0) }, pageSize: 3)
		await h.store.start()
		for id in 4...12 { await h.api.append(chatMsg(id)) }
		await h.store.sync()
		#expect(h.store.messages.compactMap(\.serverID) == [10, 11, 12])
		#expect(h.store.hasEarlier)
		await h.store.loadEarlier()
		await h.store.loadEarlier()
		await h.store.loadEarlier()
		#expect(h.store.messages.compactMap(\.serverID) == Array(1...12))
	}

	@Test("coming back to the foreground refetches")
	func foregroundRefetch() async {
		let h = ChatHarness(server: [chatMsg(1)])
		h.store.isActive = false
		await h.store.start()
		await h.api.append(chatMsg(2, by: "relay", agent: true, "while you were away"))
		h.store.isActive = true
		#expect(await eventually { h.store.messages.count == 2 })
	}

	@Test("pull to refresh waits for the pass that covers it")
	func refreshWaits() async {
		let h = ChatHarness(server: [chatMsg(1)])
		await h.store.start()
		await h.api.append(chatMsg(2, by: "relay", agent: true))
		async let a: Void = h.store.sync()
		async let b: Void = h.store.refresh()
		_ = await (a, b)
		#expect(h.store.messages.compactMap(\.serverID) == [1, 2])
	}

	@Test("a stream reconnect re-reads the thread in full")
	func reconnectResyncs() async {
		let hub = scriptedHub([conversationFrame(10, conversation: "other")])
		let h = ChatHarness(server: [chatMsg(1)], events: hub)
		await h.store.start()
		let before = await h.api.messageCalls.count
		await h.api.append(chatMsg(2, by: "relay", agent: true, "missed"))
		hub.connect(workspaceId: "w1")
		#expect(await eventually { h.store.messages.count == 2 })
		#expect(await h.api.messageCalls.count > before)
		h.store.stop()
	}

	@Test("working agents come from live sessions, not just from a send")
	func workingFromSessions() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay, chatSam]))
		await h.api.setSessions([
			ChatAgentSession(
				id: "s1", actorID: "relay", status: .running, currentActivity: "Reading the brief",
				startedAt: chatT0, updatedAt: chatT0)
		])
		await h.store.start()
		#expect(h.store.workingAgents().map(\.id) == ["relay"])
		#expect(h.store.activity(for: "relay") == "Reading the brief")
	}

	@Test("a session that stopped updating long ago doesn't read as working")
	func staleSession() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([
			ChatAgentSession(
				id: "s1", actorID: "relay", status: .running, startedAt: chatT0.addingTimeInterval(-7200),
				updatedAt: chatT0.addingTimeInterval(-7200))
		])
		await h.store.start()
		#expect(h.store.workingAgents().isEmpty)
	}

	@Test("after a send agents show as working for the spawn grace, then stop if nothing runs")
	func spawnGrace() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.store.start()
		#expect(h.store.workingAgents().isEmpty)
		h.store.send("ping")
		#expect(h.store.workingAgents().map(\.id) == ["relay"])
		#expect(h.store.workingAgents(at: chatT0.addingTimeInterval(600)).isEmpty)
	}

	@Test("a reply landing clears the working indicator")
	func replyClears() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.store.start()
		h.store.send("ping")
		#expect(await h.settled())
		#expect(!h.store.workingAgents().isEmpty)
		await h.api.append(chatMsg(5, by: "relay", agent: true, "pong"))
		await h.store.sync()
		#expect(h.store.workingAgents().isEmpty)
	}

	@Test("a paused session offers resume only while nothing is running")
	func stalled() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([
			ChatAgentSession(id: "s1", actorID: "relay", status: .paused, startedAt: chatT0)
		])
		await h.store.start()
		#expect(h.store.stalledSession()?.id == "s1")
		await h.store.resumeSession("s1")
		#expect(await h.api.resumed == ["s1"])
		await h.api.setSessions([
			ChatAgentSession(id: "s2", actorID: "relay", status: .running, startedAt: chatT0, updatedAt: chatT0),
			ChatAgentSession(id: "s1", actorID: "relay", status: .paused, startedAt: chatT0.addingTimeInterval(-9)),
		])
		await h.store.refreshSessions()
		#expect(h.store.stalledSession() == nil)
		await h.store.stopSession("s2")
		#expect(await h.api.stopped == ["s2"])
	}

	@Test("read cursor advances to the newest message, once, and never while inactive")
	func markRead() async {
		let h = ChatHarness(server: [chatMsg(1), chatMsg(2)])
		var told: [Int] = []
		h.store.onMarkedRead = { _, last in told.append(last) }
		h.store.isActive = false
		await h.store.start()
		#expect(await h.api.readCalls.isEmpty)
		h.store.isActive = true
		#expect(await eventually { await h.api.readCalls == [2] })
		await h.store.markReadIfNeeded()
		#expect(await h.api.readCalls == [2])
		await h.api.append(chatMsg(3))
		await h.store.sync()
		#expect(await h.api.readCalls == [2, 3])
		#expect(told == [2, 3])
	}

	@Test("an already-read thread doesn't call the server again")
	func alreadyRead() async {
		let h = ChatHarness(server: [chatMsg(1), chatMsg(2)], detail: chatConvo("c1", lastRead: 2))
		await h.store.start()
		#expect(await h.api.readCalls.isEmpty)
	}

	@Test("retrying an agent error reply targets the human message before it")
	func retryAgentReply() async {
		let failed = chatMsg(
			4, by: "relay", agent: true, "Model error",
			metadata: .object(["final_output": .object(["is_error": .bool(true)])]))
		let h = ChatHarness(server: [chatMsg(1, by: "me"), chatMsg(2, by: "relay", agent: true), chatMsg(3, by: "me"), failed])
		await h.store.start()
		let reply = h.store.messages.last!
		#expect(reply.isErrorReply)
		await h.store.retryAgent(for: reply)
		let call = await h.api.retried.first
		#expect(call?.0 == 3)
		#expect(call?.1 == "relay")
	}

	@Test("a conversation event for this chat pulls the new message in live")
	func liveEvent() async {
		let hub = scriptedHub([conversationFrame(10, conversation: "c1")])
		let h = ChatHarness(server: [chatMsg(1)], events: hub)
		await h.store.start()
		await h.api.append(chatMsg(2, by: "relay", agent: true, "streamed in"))
		hub.connect(workspaceId: "w1")
		#expect(await eventually { h.store.messages.count == 2 })
		#expect(h.store.messages.last?.content == "streamed in")
		h.store.stop()
	}

	@Test("events for other conversations trigger no incremental sync")
	func otherConversation() async {
		let hub = scriptedHub([conversationFrame(10, conversation: "other")])
		let h = ChatHarness(server: [chatMsg(1)], events: hub)
		await h.store.start()
		hub.connect(workspaceId: "w1")
		try? await Task.sleep(for: .milliseconds(200))
		#expect(await h.api.messageCalls.allSatisfy { $0.after == nil })
		h.store.stop()
	}

	// MARK: Questions

	@Test("an agent's question is read from metadata, with options and multi-select")
	func parsesQuestion() {
		let m = chatMsg(7, by: "relay", agent: true, "Which environment?", metadata: questionMeta)
		#expect(m.questions.count == 1)
		#expect(m.questions[0].header == "Env")
		#expect(m.questions[0].options.map(\.label) == ["Staging", "Prod"])
		#expect(m.questions[0].options[1].detail == "Live users")
		#expect(m.questionSessionID == "s1")
	}

	@Test("answering posts the web's message shape and marks the question answered")
	func answersQuestion() async {
		let q = chatMsg(7, by: "relay", agent: true, "Which environment?", metadata: questionMeta)
		let h = ChatHarness(server: [q], online: false)
		await h.store.start()
		#expect(h.store.answeredQuestionIDs.isEmpty)
		// Partial answers are refused.
		#expect(h.store.answer(question: q, picks: [:]) == nil)
		#expect(h.store.answer(question: q, picks: [0: ["Prod"]]) != nil)
		let sent = h.store.messages.last
		#expect(sent?.content == "**Env** \u{2014} Which environment?\nProd")
		#expect(sent?.answeredQuestionID == 7)
		#expect(sent?.questionAnswers == [.init(header: "Env", selected: ["Prod"])])
		#expect(h.store.answeredQuestionIDs == [7])
		// Offline: it is queued, and goes out when the network returns.
		h.network.set(online: true)
		#expect(await h.settled())
		let meta = await h.api.sentMetadata.first
		#expect(meta??.questionAnswer == ChatQuestionAnswer(questionMessageID: 7, answers: [.init(header: "Env", selected: ["Prod"])]))
	}

	// MARK: Thread management

	@Test("rename is optimistic and rolls back if the server refuses")
	func rename() async {
		let h = ChatHarness(detail: chatConvo("c1", title: "Old"))
		await h.store.start()
		await h.store.rename(to: "  New  ")
		#expect(h.store.title == "New")
		#expect(await h.api.renamed == ["New"])
		await h.api.setFailMutations(true)
		await h.store.rename(to: "Broken")
		#expect(h.store.title == "New")
		#expect(h.store.notice != nil)
	}

	@Test("removing a participant rolls back if the server refuses")
	func removeParticipant() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay, chatSam]))
		await h.store.start()
		await h.store.removeParticipant("sam")
		#expect(h.store.participants.map(\.id) == ["me", "relay"])
		await h.api.setFailMutations(true)
		await h.store.removeParticipant("relay")
		#expect(h.store.participants.map(\.id) == ["me", "relay"])
	}
}

@Suite("ChatSendMetadata")
struct ChatSendMetadataTests {
	@Test("encodes exactly the API's keys and nothing else")
	func wireShape() throws {
		let meta = ChatSendMetadata(
			attachments: [ChatAttachmentRef(fileID: "f1", name: "a.png", mimeType: "image/png", sizeBytes: 3)],
			mentions: ["actor-1"],
			questionAnswer: ChatQuestionAnswer(questionMessageID: 4, answers: [.init(header: "H", selected: ["x"])]))
		let json = try #require(meta.jsonValue)
		#expect(json["attachments"] != nil)
		#expect(json["mentions"] == .array([.string("actor-1")]))
		let attachment = try #require({ () -> JSONValue? in
			if case .array(let a)? = json["attachments"] { return a.first }
			return nil
		}())
		#expect(attachment["file_id"] == .string("f1"))
		#expect(attachment["mime_type"] == .string("image/png"))
		#expect(attachment["size_bytes"] == .number(3))
		#expect(json["question_answer"]?["question_message_id"] == .number(4))
	}

	@Test("empty metadata is empty and encodes to nothing")
	func empty() {
		#expect(ChatSendMetadata().isEmpty)
		#expect(ChatSendMetadata(attachments: [], mentions: []).jsonValue == nil)
	}

	@Test("a message exposes its attachments and mentions")
	func readsBack() {
		let meta = ChatSendMetadata(
			attachments: [ChatAttachmentRef(fileID: "f1", name: "a.png", mimeType: "image/png", sizeBytes: 3)],
			mentions: ["m1", "m2"])
		let message = chatMsg(1, metadata: meta.jsonValue)
		#expect(message.attachments.map(\.fileID) == ["f1"])
		#expect(message.attachments.first?.name == "a.png")
		#expect(message.mentionIDs == ["m1", "m2"])
	}
}
