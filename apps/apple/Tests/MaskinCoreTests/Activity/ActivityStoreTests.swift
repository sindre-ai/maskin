import Foundation
import Testing

@testable import MaskinCore

private actor FakeActivitySource: SessionActivitySource {
	var pages: [String: SessionActivity] = [:]
	private(set) var requests: [(session: String, turns: Int, background: Bool)] = []

	func set(_ page: SessionActivity) { pages[page.sessionID] = page }

	func activity(sessionID: String, limitTurns: Int, background: Bool) async throws -> SessionActivity {
		requests.append((sessionID, limitTurns, background))
		guard let page = pages[sessionID] else { throw ChatsHTTPError(status: 404, message: "nope") }
		return page
	}

	func requestCount() -> Int { requests.count }
	func lastRequest() -> (session: String, turns: Int, background: Bool)? { requests.last }
}

private func turn(
	_ session: String, _ message: Int, status: ActivityStep.Status = .completed,
	reply: Bool = true, steps: Int = 2
) -> ActivityTurn {
	ActivityTurn(
		sessionID: session, messageID: message, status: status, containsReply: reply,
		steps: (0..<steps).map { ActivityStep(id: "\(message)-\($0)", kind: .toolUse, label: "Step \($0)") })
}

private func session(_ id: String, _ status: ChatAgentSession.Status, actor: String = "relay")
	-> ChatAgentSession
{
	ChatAgentSession(id: id, actorID: actor, status: status)
}

@Suite("ActivityStore")
@MainActor
struct ActivityStoreTests {
	@Test("a finished session is fetched once with the history cap, as background traffic")
	func historyOnce() async {
		let source = FakeActivitySource()
		await source.set(SessionActivity(sessionID: "s1", turns: [turn("s1", 5)]))
		let store = ActivityStore(source: source)
		await store.update(sessions: [session("s1", .completed)])
		await store.update(sessions: [session("s1", .completed)])
		#expect(await source.requestCount() == 1)
		let request = await source.lastRequest()
		#expect(request?.turns == ActivityStore.historyTurns)
		#expect(request?.background == true)
		#expect(store.turnsBySession["s1"]?.count == 1)
	}

	@Test("a live session is polled for the newest turn only, and exposes the running one")
	func livePolling() async throws {
		let source = FakeActivitySource()
		await source.set(SessionActivity(sessionID: "s1", turns: [turn("s1", 5, status: .running, reply: false)]))
		let store = ActivityStore(
			source: source, activeInterval: .milliseconds(20), idleInterval: .milliseconds(20))
		await store.update(sessions: [session("s1", .running)])
		// Wait for at least two polls (bounded), rather than a fixed sleep that flakes under load.
		for _ in 0..<150 where await source.requestCount() < 2 { try await Task.sleep(for: .milliseconds(20)) }
		store.stop()
		#expect(store.liveTurn(sessionID: "s1")?.messageID == 5)
		let request = await source.lastRequest()
		#expect(request?.turns == ActivityStore.liveTurns)
		#expect(request?.background == false)
		#expect(await source.requestCount() >= 2)
	}

	@Test("when a session ends it is read once more to pick up the closing turn")
	func finalRead() async throws {
		let source = FakeActivitySource()
		await source.set(SessionActivity(sessionID: "s1", turns: [turn("s1", 5, status: .running, reply: false)]))
		let store = ActivityStore(
			source: source, activeInterval: .seconds(30), idleInterval: .seconds(30))
		await store.update(sessions: [session("s1", .running)])
		for _ in 0..<150 where store.liveTurn(sessionID: "s1") == nil { try await Task.sleep(for: .milliseconds(20)) }
		await source.set(SessionActivity(sessionID: "s1", turns: [turn("s1", 5)]))
		await store.update(sessions: [session("s1", .completed)])
		store.stop()
		#expect(store.liveTurn(sessionID: "s1") == nil)
		#expect(store.turnsBySession["s1"]?.first?.status == .completed)
	}

	@Test("a failing endpoint leaves no trace and does not retry in a loop")
	func failureIsQuiet() async {
		let source = FakeActivitySource()
		let store = ActivityStore(source: source)
		await store.update(sessions: [session("s1", .completed)])
		await store.update(sessions: [session("s1", .completed)])
		#expect(store.turnsBySession["s1"] == nil)
		#expect(await source.requestCount() == 1)
	}

	@Test("finished sessions are cached on disk, so reopening a thread costs no request")
	func cachesFinished() async throws {
		let dir = FileManager.default.temporaryDirectory.appendingPathComponent("act-\(UUID().uuidString)")
		let cache = SnapshotCache(
			disk: DiskCache(directory: dir), actorId: { "a" }, workspaceId: { "w" })
		let source = FakeActivitySource()
		await source.set(SessionActivity(sessionID: "s1", turns: [turn("s1", 5)]))
		await ActivityStore(source: source, cache: cache).update(sessions: [session("s1", .completed)])
		let second = ActivityStore(source: source, cache: cache)
		await second.update(sessions: [session("s1", .completed)])
		#expect(await source.requestCount() == 1)
		#expect(second.turnsBySession["s1"]?.first?.messageID == 5)
	}

	@Test("a finished turn sits above its reply; one with no reply sits after its trigger")
	func anchoring() async {
		let source = FakeActivitySource()
		await source.set(
			SessionActivity(
				sessionID: "s1",
				turns: [
					turn("s1", 1),
					turn("s1", 3, status: .failed, reply: false, steps: 1),
					turn("s1", 6, reply: true, steps: 0),
				]))
		let store = ActivityStore(source: source)
		await store.update(sessions: [session("s1", .completed)])
		let messages = [
			chatMsg(1, by: "me", "ask"), chatMsg(2, by: "relay", agent: true, "answer"),
			chatMsg(3, by: "me", "ask again"), chatMsg(6, by: "me", "and again"),
			chatMsg(7, by: "relay", agent: true, "done"),
		]
		let anchors = store.anchors(messages: messages, sessions: [session("s1", .completed)])
		#expect(anchors.aboveReply[2]?.messageID == 1)
		#expect(anchors.afterTrigger[3]?.messageID == 3)
		// Reply 7 belongs to turn 6, which has no steps and no failure: nothing to show.
		#expect(anchors.aboveReply[7] == nil)
		#expect(anchors.afterTrigger[6] == nil)
	}

	@Test("a reply is never claimed by two turns")
	func noDoubleClaim() async {
		let source = FakeActivitySource()
		await source.set(SessionActivity(sessionID: "s1", turns: [turn("s1", 1), turn("s1", 2)]))
		let store = ActivityStore(source: source)
		await store.update(sessions: [session("s1", .completed)])
		let messages = [
			chatMsg(1, by: "me", "a"), chatMsg(2, by: "me", "b"), chatMsg(3, by: "relay", agent: true, "r"),
		]
		let anchors = store.anchors(messages: messages, sessions: [session("s1", .completed)])
		#expect(anchors.aboveReply.count == 1)
		#expect(anchors.aboveReply[3]?.messageID == 2)
		#expect(anchors.afterTrigger[1]?.messageID == 1)
	}

	@Test("a turn stuck running on a finished session is shown as interrupted and cached")
	func interruptedTurn() async throws {
		let dir = FileManager.default.temporaryDirectory.appendingPathComponent("act-\(UUID().uuidString)")
		let cache = SnapshotCache(
			disk: DiskCache(directory: dir), actorId: { "a" }, workspaceId: { "w" })
		let source = FakeActivitySource()
		await source.set(
			SessionActivity(sessionID: "s1", turns: [turn("s1", 5, status: .running, reply: false, steps: 1)]))
		let store = ActivityStore(source: source, cache: cache)
		await store.update(sessions: [session("s1", .failed)])
		#expect(store.liveTurn(sessionID: "s1") == nil)
		#expect(store.turnsBySession["s1"]?.first?.status == .failed)
		let anchors = store.anchors(messages: [chatMsg(5, by: "me", "go")], sessions: [session("s1", .failed)])
		#expect(anchors.afterTrigger[5]?.failed == true)
		// Cached: reopening costs no request.
		let reopened = ActivityStore(source: source, cache: cache)
		await reopened.update(sessions: [session("s1", .failed)])
		#expect(await source.requestCount() == 1)
		#expect(reopened.turnsBySession["s1"]?.first?.status == .failed)
	}

	@Test("anchors are memoized until the trace or the thread changes")
	func anchorsMemoized() async {
		let source = FakeActivitySource()
		await source.set(SessionActivity(sessionID: "s1", turns: [turn("s1", 1)]))
		let store = ActivityStore(source: source)
		await store.update(sessions: [session("s1", .completed)])
		let sessions = [session("s1", .completed)]
		let messages = [chatMsg(1, by: "me", "a"), chatMsg(2, by: "relay", agent: true, "r")]
		let first = store.anchors(messages: messages, sessions: sessions)
		#expect(store.anchors(messages: messages, sessions: sessions) == first)
		#expect(first.aboveReply[2]?.messageID == 1)
		// A new reply changes the answer (the memo must not serve the old one).
		let more = messages + [chatMsg(3, by: "me", "b"), chatMsg(4, by: "relay", agent: true, "r2")]
		#expect(store.anchors(messages: more, sessions: sessions).aboveReply[2]?.messageID == 1)
	}
}
