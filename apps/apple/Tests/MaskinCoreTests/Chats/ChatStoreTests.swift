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

	@Test("a message that holds a secret is never queued, from any screen")
	func secretIsNeverQueued() async {
		let h = ChatHarness()
		await h.store.start()
		let key = "sk_live_" + String(repeating: "a1B2", count: 7)
		#expect(h.store.send("use \(key) now") == nil)
		#expect(h.store.messages.isEmpty)
		#expect(h.store.notice == ChatsHTTPError.rawSecretMessage)
		#expect(await h.api.sentContents.isEmpty)
	}

	@Test("a send the server refused for a secret keeps the words but not the key, in memory and on disk")
	func refusedSecretDoesNotStayOnDisk() async throws {
		let failedFile = FileManager.default.temporaryDirectory.appendingPathComponent("failed-\(UUID().uuidString).json")
		defer { try? FileManager.default.removeItem(at: failedFile) }
		let h = ChatHarness(failedFile: failedFile)
		await h.store.start()
		let key = "sk_live_" + String(repeating: "a1B2", count: 7)
		await h.api.failNextSends([ChatsHTTPError(status: 400, message: ChatsHTTPError.rawSecretMessage)])
		// Straight onto the queue, as a path that does not pass the store's own check would.
		_ = try h.queue.send(conversationID: "c1", content: "use \(key) for billing", afterServerID: nil)
		#expect(await eventually { !h.queue.failed.isEmpty })
		#expect(h.queue.failed.first?.content == "use for billing")
		let onDisk = try String(contentsOf: failedFile, encoding: .utf8)
		#expect(!onDisk.contains(key))
		#expect(onDisk.contains("use for billing"))
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

	@Test("my message never drops out between the server confirming it and the thread hearing of it")
	func deliveryHasNoGap() async {
		let h = ChatHarness(online: false)
		await h.store.start()
		let rowID = h.store.send("hello")!
		let clientID = String(rowID.dropFirst("local-".count))
		#expect(h.store.messages.count == 1)
		// The queue confirms the send and the outbox drops its entry in the same turn, before the
		// store's event stream has been read. The message must be visible throughout.
		h.queue.recordDelivery(clientID: clientID, message: chatMsg(5, by: "me", "hello"))
		_ = h.queue.discard(clientID)
		#expect(h.store.messages.compactMap(\.serverID) == [5])
		#expect(h.store.messages.first?.id == rowID)
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

	@Test("a session event re-reads the thread so a handoff row follows its session")
	func handoffRowFollowsSessionEvents() async {
		func handoff(_ status: String) -> SpawnedSession {
			SpawnedSession(
				id: "sub1", status: status, actorID: "dev", actorName: "Dev", actionPrompt: "Fix it")
		}
		var parent = chatMsg(1, by: "relay", agent: true, "handing off")
		parent.spawnedSessions = [handoff("running")]
		let hub = scriptedHub([conversationFrame(10, conversation: "sub1", action: "updated", entity: "session")])
		let h = ChatHarness(server: [parent], events: hub)
		await h.store.start()
		#expect(h.store.messages.first?.spawnedSessions.first?.pill == .working)
		parent.spawnedSessions = [handoff("completed")]
		await h.api.set(server: [parent])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { h.store.messages.first?.spawnedSessions.first?.pill == .done })
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

	@Test("Stop takes effect at once even when the server still reports the session running")
	func stopIsImmediate() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		// The server's stop only tears the sandbox down: the row stays `running` until a later settle.
		await h.api.setSessions([
			ChatAgentSession(id: "s1", actorID: "relay", status: .running, startedAt: chatT0, updatedAt: chatT0)
		])
		await h.store.start()
		#expect(h.store.liveSessions().map(\.id) == ["s1"])
		await h.store.stopSession("s1")
		#expect(await h.api.stopped == ["s1"])
		#expect(h.store.liveSessions().isEmpty)
		#expect(h.store.workingAgents().isEmpty)
	}

	@Test("a failed Stop keeps the session live and says why")
	func stopFailureKeepsSession() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([
			ChatAgentSession(id: "s1", actorID: "relay", status: .running, startedAt: chatT0, updatedAt: chatT0)
		])
		await h.api.failStop(true)
		await h.store.start()
		await h.store.stopSession("s1")
		#expect(h.store.liveSessions().map(\.id) == ["s1"])
		#expect(h.store.notice != nil)
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

	@Test("above the bottom, read state follows what the reader has scrolled past")
	func readFollowsSeen() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true), chatMsg(2, by: "relay", agent: true), chatMsg(3, by: "relay", agent: true)],
			detail: chatConvo("c1", lastRead: 0))
		var told: [Int] = []
		h.store.onMarkedRead = { _, last in told.append(last) }
		h.store.isAtBottom = false
		await h.store.start()
		// Rows on screen before the opening position is chosen are not the reader reading.
		h.store.noteSeen(3)
		#expect(h.store.seenThrough == 0)
		h.store.countsSeen = true
		h.store.noteSeen(2)
		#expect(await eventually { await h.api.readCalls == [2] })
		#expect(told.isEmpty)  // the list keeps its badge until the thread is read to the end
		h.store.isAtBottom = true
		await h.store.markReadIfNeeded()
		#expect(await h.api.readCalls == [2, 3])
		#expect(told == [3])
	}

	@Test("above the bottom, a newest message the reader cannot scroll to does not keep the chat unread")
	func readPastHiddenAndOwnMessages() async {
		var reply = chatMsg(3, by: "relay", agent: true)
		reply.threadRootID = 1
		let h = ChatHarness(
			server: [chatMsg(1, by: "relay", agent: true), chatMsg(2, by: "relay", agent: true), reply, chatMsg(4)],
			detail: chatConvo("c1", lastRead: 0))
		var told: [Int] = []
		h.store.onMarkedRead = { _, last in told.append(last) }
		h.store.isAtBottom = false
		await h.store.start()
		h.store.countsSeen = true
		#expect(h.store.timelineHasUnseen(after: 1))
		#expect(!h.store.timelineHasUnseen(after: 2))
		// The reader has read message 2, the last one the timeline shows from anyone else: a thread
		// reply (3) and their own message (4) come after it, so the chat is read to its end.
		h.store.noteSeen(2)
		#expect(await eventually { await h.api.readCalls == [4] })
		#expect(told == [4])
	}

	@Test("the opening position is known from the saved thread or the server")
	func openPositionKnown() async {
		let h = ChatHarness(server: [chatMsg(1), chatMsg(2)], detail: chatConvo("c1", lastRead: 1))
		#expect(!h.store.openPositionKnown)
		await h.store.start()
		#expect(h.store.openPositionKnown)
		#expect(h.store.openedReadCursor == 1)
	}

	@Test("the thread is only server-confirmed once the newest page has been read")
	func serverConfirmed() async {
		let h = ChatHarness(server: [chatMsg(1), chatMsg(2)], detail: chatConvo("c1", lastRead: 1))
		#expect(!h.store.serverConfirmed)
		await h.store.start()
		#expect(h.store.serverConfirmed)
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

	// MARK: Editing and the unread cursor

	@Test("editing your own message shows the new text at once and keeps what the server returns")
	func editOwnMessage() async {
		let h = ChatHarness(server: [chatMsg(1, by: "me", "teh plan"), chatMsg(2, by: "relay", agent: true, "ok")])
		await h.store.start()
		let id = h.store.messages.first { $0.serverID == 1 }!.id
		await h.store.edit(id, to: "  the plan  ")
		let edited = h.store.messages.first { $0.serverID == 1 }!
		#expect(edited.content == "the plan")
		#expect(edited.editedAt != nil)
		#expect(await h.api.edits.map(\.1) == ["the plan"])
		#expect(h.store.messages.first { $0.serverID == 1 }?.id == id)
	}

	@Test("a refused edit puts the old text back with a notice")
	func editRollsBack() async {
		let h = ChatHarness(server: [chatMsg(1, by: "me", "teh plan")])
		await h.store.start()
		await h.api.setFailMutations(true)
		let id = h.store.messages[0].id
		await h.store.edit(id, to: "the plan")
		#expect(h.store.messages[0].content == "teh plan")
		#expect(h.store.messages[0].editedAt == nil)
		#expect(h.store.notice != nil)
	}

	@Test("nothing is sent for someone else's message, an agent's, an empty edit or an unchanged one")
	func editGuards() async {
		let h = ChatHarness(server: [
			chatMsg(1, by: "sam", name: "Sam", "theirs"), chatMsg(2, by: "relay", agent: true, "agent"),
			chatMsg(3, by: "me", "mine"),
		])
		await h.store.start()
		let ids = Dictionary(uniqueKeysWithValues: h.store.messages.map { ($0.serverID!, $0.id) })
		await h.store.edit(ids[1]!, to: "changed")
		await h.store.edit(ids[2]!, to: "changed")
		await h.store.edit(ids[3]!, to: "   ")
		await h.store.edit(ids[3]!, to: "mine")
		#expect(await h.api.edits.isEmpty)
	}

	@Test("the read cursor at open is remembered, even after the thread marks itself read")
	func openedCursor() async {
		let h = ChatHarness(
			server: [chatMsg(1, by: "relay", agent: true, "a"), chatMsg(2, by: "relay", agent: true, "b")],
			detail: chatConvo("c1", unread: 1, lastRead: 1))
		await h.store.start()
		#expect(h.store.openedReadCursor == 1)
		#expect(await h.api.readCalls.contains(2))
	}

	// MARK: A failed refresh must not look like a complete thread

	@Test("a failed refresh keeps the rows but says the newest messages didn't load")
	func failedRefreshIsVisible() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "old")])
		await h.store.start()
		#expect(h.store.syncProblem == nil)
		await h.api.append(chatMsg(2, by: "relay", agent: true, "new"))
		await h.api.setFailMessages(true)
		await h.store.refresh()
		#expect(h.store.messages.map(\.serverID) == [1])
		#expect(h.store.syncProblem != nil)
		await h.api.setFailMessages(false)
		await h.store.refresh()
		#expect(h.store.syncProblem == nil)
		#expect(h.store.messages.map(\.serverID) == [1, 2])
	}

	@Test("a load that fails over cached rows retries by itself until the newest messages arrive")
	func loadRetriesByItself() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "old")], retryDelays: [.milliseconds(30), .milliseconds(30)])
		await h.store.start()
		await h.api.append(chatMsg(2, by: "relay", agent: true, "new"))
		await h.api.setFailMessages(true)
		await h.store.load()
		#expect(h.store.syncProblem != nil)
		await h.api.setFailMessages(false)
		#expect(await eventually { h.store.messages.map(\.serverID) == [1, 2] })
		#expect(h.store.syncProblem == nil)
	}

	@Test("a thread whose newest message is older than the conversation's reads the newest page again")
	func closesAGap() async {
		let h = ChatHarness(
			server: [chatMsg(1, by: "relay", agent: true, "old")],
			detail: chatConvo("c1", last: chatT0.addingTimeInterval(500)))
		await h.store.start()
		let pageReads = await h.api.messageCalls.count
		// One load, plus the extra pass that checks the thread caught up.
		#expect(pageReads >= 2)
	}

	@Test("a thread that is up to date does not re-read")
	func noGap() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "a")], detail: chatConvo("c1", last: chatT0))
		await h.store.start()
		#expect(await h.api.messageCalls.count == 1)
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

private actor IdleTraceSource: SessionActivitySource {
	let turns: [ActivityTurn]
	init(_ turns: [ActivityTurn]) { self.turns = turns }
	func activity(sessionID: String, limitTurns: Int, background: Bool) async throws -> SessionActivity {
		SessionActivity(sessionID: sessionID, turns: turns)
	}
}

@Suite("ChatStore trace loading")
@MainActor
struct ChatStoreTraceLoadingTests {
	@Test("the trace counts as loading from a sessions read until the finished turns have landed")
	func loadingUntilHistoryLands() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([ChatAgentSession(id: "s1", actorID: "relay", status: .completed, startedAt: chatT0)])
		h.store.trace = ActivityStore(source: IdleTraceSource([]))
		#expect(!h.store.isLoadingTrace)
		await h.store.refreshSessions()
		#expect(await eventually { !h.store.isLoadingTrace })
	}

	@Test("without a trace store nothing is left loading")
	func noTraceStore() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([ChatAgentSession(id: "s1", actorID: "relay", status: .completed, startedAt: chatT0)])
		await h.store.refreshSessions()
		#expect(await eventually { !h.store.isLoadingTrace })
	}
}

@Suite("ChatStore idle sessions")
@MainActor
struct ChatStoreIdleTests {
	private let running = ChatAgentSession(
		id: "s1", actorID: "relay", status: .running, startedAt: chatT0.addingTimeInterval(-900),
		updatedAt: chatT0.addingTimeInterval(-60))

	private func harness(turn: ActivityTurn, messages: [ChatMessage]) async -> ChatHarness {
		let h = ChatHarness(server: messages, detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([running])
		let trace = ActivityStore(
			source: IdleTraceSource([turn]), activeInterval: .seconds(60), idleInterval: .seconds(60))
		await h.store.start()
		h.store.trace = trace
		if turn.isRunning {
			await trace.update(sessions: [running])
			_ = await eventually { trace.liveTurn(sessionID: "s1") != nil }
		} else {
			// History is read for sessions that aren't live; load the finished turn that way.
			var loaded = running
			loaded.status = .completed
			await trace.update(sessions: [loaded])
		}
		trace.stop()
		return h
	}

	private func turn(_ status: ActivityStep.Status) -> ActivityTurn {
		ActivityTurn(sessionID: "s1", messageID: 1, status: status, containsReply: true)
	}

	@Test("a running interactive session whose turn finished is idle, not working")
	func idleAfterReply() async {
		let h = await harness(
			turn: turn(.completed),
			messages: [chatMsg(1, at: -600), chatMsg(2, by: "relay", agent: true, "done", at: -590)])
		#expect(h.store.isIdle(running))
		#expect(h.store.workingAgents().isEmpty)
		#expect(h.store.liveSessions().isEmpty)
		h.store.stop()
	}

	@Test("a turn still running keeps the session working")
	func runningTurn() async {
		let h = await harness(turn: turn(.running), messages: [chatMsg(1, at: -30)])
		#expect(!h.store.isIdle(running))
		#expect(h.store.workingAgents().map(\.id) == ["relay"])
		h.store.stop()
	}

	@Test("a fresh message after the finished turn is not idle while the next turn spins up")
	func freshMessage() async {
		let h = await harness(
			turn: turn(.completed),
			messages: [chatMsg(1, at: -600), chatMsg(2, by: "relay", agent: true, "done", at: -590), chatMsg(3, at: -2)])
		#expect(!h.store.isIdle(running))
		h.store.stop()
	}

	@Test("without a trace nothing is known, so the session still counts as working")
	func noTrace() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([running])
		await h.store.start()
		#expect(!h.store.isIdle(running))
		#expect(h.store.workingAgents().map(\.id) == ["relay"])
		h.store.stop()
	}
}

@Suite("ChatStore final_output idle rule")
@MainActor
struct ChatStoreFinalOutputTests {
	private let running = ChatAgentSession(
		id: "s1", actorID: "relay", status: .running, startedAt: chatT0.addingTimeInterval(-900))
	private let finalMeta: JSONValue = .object(["source": .string("final_output")])

	@Test("a final_output reply newer than the user's message means idle without a trace")
	func idle() async {
		let h = ChatHarness(
			server: [chatMsg(1, at: -600), chatMsg(2, by: "relay", agent: true, "done", at: -590, metadata: finalMeta)],
			detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([running])
		await h.store.start()
		#expect(h.store.workingAgents().isEmpty)
		#expect(h.store.idleSessions().map(\.id) == ["s1"])
		h.store.stop()
	}

	@Test("a user message after the reply means the next turn is due")
	func newerUserMessage() async {
		let h = ChatHarness(
			server: [chatMsg(2, by: "relay", agent: true, "done", at: -590, metadata: finalMeta), chatMsg(3, at: -5)],
			detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setSessions([running])
		await h.store.start()
		#expect(h.store.workingAgents().map(\.id) == ["relay"])
		#expect(h.store.idleSessions().isEmpty)
		h.store.stop()
	}
}

@Suite("ChatStore spec 7 state: pinned, overrides, stopped, presence")
@MainActor
struct ChatStoreSpec7StateTests {
	@Test("pinning keeps one message per chat, survives a new store on the same pin store, and unpins")
	func pinned() async {
		let pins = MemoryChatPinStore()
		let rows = [chatMsg(1, by: "relay", agent: true, "Plan"), chatMsg(2, by: "relay", agent: true, "Budget")]
		let h = ChatHarness(server: rows, pinStore: pins)
		await h.store.start()
		#expect(h.store.pinnedMessage == nil)
		h.store.pin(h.store.messages[0])
		#expect(h.store.pinnedMessage?.content == "Plan")
		#expect(h.store.isPinned(h.store.messages[0]))
		h.store.pin(h.store.messages[1])
		#expect(h.store.pinnedMessage?.content == "Budget", "one pinned message per chat")
		#expect(!h.store.isPinned(h.store.messages[0]))
		// A pending message has no stable id and cannot be pinned.
		var pending = chatMsg(9)
		pending.serverID = nil
		h.store.pin(pending)
		#expect(h.store.pinnedMessageServerID == 2)

		let reopened = ChatHarness(server: rows, pinStore: pins)
		await reopened.store.start()
		#expect(reopened.store.pinnedMessage?.content == "Budget")
		reopened.store.unpin()
		#expect(reopened.store.pinnedMessage == nil)
		#expect(pins.pinnedMessageID(conversationID: "c1") == nil)
	}

	@Test("versions start from the message's own text, step, and lock while a reply is in flight")
	func versions() async {
		let h = ChatHarness(server: [chatMsg(1, by: "me", "Summarise"), chatMsg(2, by: "relay", agent: true, "Long answer")])
		await h.store.start()
		let id = h.store.messages[1].id
		#expect(h.store.override(for: id) == MessageOverride())
		#expect(!h.store.override(for: id).hasVersions)
		h.store.addVersion("Short answer", to: id)
		let override = h.store.override(for: id)
		#expect(override.versions == ["Long answer", "Short answer"])
		#expect(override.versionIndex == 1)
		#expect(override.text(original: "Long answer") == "Short answer")
		h.store.selectVersion(0, of: id)
		#expect(h.store.override(for: id).text(original: "Long answer") == "Long answer")
		h.store.selectVersion(5, of: id)
		#expect(h.store.override(for: id).versionIndex == 0, "out-of-range is ignored")
		// Locked while a reply is streaming.
		h.store.send("again")
		h.store.selectVersion(1, of: id)
		#expect(h.store.override(for: id).versionIndex == 0)
	}

	@Test("feedback is kept per message and clearing it drops the empty override")
	func feedback() async {
		let h = ChatHarness(server: [chatMsg(2, by: "relay", agent: true, "Answer")])
		await h.store.start()
		let id = h.store.messages[0].id
		h.store.setFeedback(.good, on: id)
		#expect(h.store.override(for: id).feedback == .good)
		h.store.setFeedback(nil, on: id)
		#expect(h.store.overrides[id] == nil)
	}

	@Test("asking for a shorter answer quotes the message and sends through the outbox")
	func shorter() async {
		let h = ChatHarness(server: [chatMsg(2, by: "relay", name: "Relay", agent: true, "A long answer")])
		await h.store.start()
		let id = h.store.askForShorter(h.store.messages[0])
		#expect(id != nil)
		#expect(await h.settled())
		let sent = await h.api.sentContents.last ?? ""
		#expect(sent.hasPrefix("> **Relay**\n> A long answer"))
		#expect(sent.hasSuffix("Make it shorter"))
	}

	@Test("stopping a live agent marks its reply Stopped until it answers again or you ask again")
	func stopped() async {
		let h = ChatHarness(server: [chatMsg(1, by: "me", "Go")])
		await h.api.setSessions([ChatAgentSession(id: "s1", actorID: "relay", status: .running, startedAt: chatT0)])
		await h.store.start()
		#expect(h.store.liveSessions().map(\.id) == ["s1"])
		await h.store.stopSession("s1")
		#expect(h.store.stoppedAgentIDs == ["relay"])
		#expect(await h.api.stopped == ["s1"])
		// A fresh answer from that agent lifts the marker; re-reading old rows does not.
		await h.store.sync(full: true)
		#expect(h.store.stoppedAgentIDs == ["relay"])
		await h.api.append(chatMsg(2, by: "relay", agent: true, "Here you go"))
		await h.store.sync()
		#expect(h.store.stoppedAgentIDs.isEmpty)

		await h.store.stopSession("s1")
		#expect(h.store.stoppedAgentIDs == ["relay"])
		h.store.send("Try once more")
		#expect(h.store.stoppedAgentIDs.isEmpty)
	}

	@Test("stopping a session that is not live leaves no Stopped marker")
	func stopIdle() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "Done")])
		await h.api.setSessions([ChatAgentSession(id: "s1", actorID: "relay", status: .completed, startedAt: chatT0)])
		await h.store.start()
		await h.store.stopSession("s1")
		#expect(h.store.stoppedAgentIDs.isEmpty)
	}

	@Test("presence: a running session with no trace is working, a fresh send is replying, idle is nil")
	func presence() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "Hi")])
		await h.store.start()
		#expect(h.store.presence(of: "relay") == nil)
		#expect(h.store.presences().isEmpty)
		h.store.send("Summarise this")
		#expect(h.store.presence(of: "relay") == .replying, "spawn grace right after a send")
		await h.api.setSessions([ChatAgentSession(id: "s1", actorID: "relay", status: .running, startedAt: chatT0)])
		await h.store.refreshSessions()
		#expect(h.store.presence(of: "relay") == .working)
		#expect(h.store.presences().map(\.presence) == [.working])
		#expect(h.store.typingAgents().isEmpty)
		await h.api.setSessions([ChatAgentSession(id: "s2", actorID: "relay", status: .pending, startedAt: chatT0)])
		await h.store.refreshSessions()
		#expect(h.store.presence(of: "relay") == .replying)
	}

	@Test("read receipts: Sent until an agent session picks the message up or an agent answers after it")
	func readBy() async {
		let h = ChatHarness(server: [chatMsg(1, by: "me", "Hello"), chatMsg(2, by: "me", "Anyone?")])
		await h.store.start()
		#expect(h.store.readBy(h.store.messages[0]) == nil)
		await h.api.setSessions([ChatAgentSession(id: "s1", actorID: "relay", status: .running, messageID: 2)])
		await h.store.refreshSessions()
		#expect(h.store.readBy(h.store.messages[1]) == "Relay")
		#expect(h.store.readBy(h.store.messages[0]) == nil)
		await h.api.append(chatMsg(3, by: "relay", agent: true, "Yes"))
		await h.store.sync()
		#expect(h.store.readBy(h.store.messages[0]) == "Relay")
		#expect(h.store.readBy(h.store.messages[2]) == nil, "only your own messages have receipts")
	}

	@Test("the live reply draft is nil until the API streams partial text")
	func noStreamYet() async {
		let h = ChatHarness()
		#expect(h.store.liveReplyDraft(for: "relay") == nil)
	}
}
