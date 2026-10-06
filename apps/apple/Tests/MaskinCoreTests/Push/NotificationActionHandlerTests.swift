import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private actor Calls {
	struct Comment: Equatable {
		var entityId: String
		var content: String
		var parent: Int?
		var key: String?
	}
	var comments: [Comment] = []
	var reads: [(String, Int, String?)] = []
	func comment(_ c: Comment) { comments.append(c) }
	func read(_ entity: String, _ id: Int, _ key: String?) { reads.append((entity, id, key)) }
}

private struct FakeBackend: DecisionBackend {
	var calls: Calls
	var commentError: (any Error)?
	var readError: (any Error)?
	var hang = false
	var delay: Duration = .zero

	func postComment(entityId: String, content: String, parentEventId: Int?) async throws {
		if hang { try await Task.sleep(for: .seconds(30)) }
		if delay > .zero { try await Task.sleep(for: delay) }
		if let commentError { throw commentError }
		await calls.comment(
			.init(entityId: entityId, content: content, parent: parentEventId, key: IdempotencyKey.current))
	}
	func markRead(entityId: String, lastEventId: Int) async throws {
		if delay > .zero { try await Task.sleep(for: delay) }
		if let readError { throw readError }
		await calls.read(entityId, lastEventId, IdempotencyKey.current)
	}
	func markUnread(entityId: String) async throws {}
}

private final class FakeQueue: DecisionQueueing, @unchecked Sendable {
	private let lock = NSLock()
	private var _writes: [QueuedDecision] = []
	var fail = false
	var writes: [QueuedDecision] { lock.withLock { _writes } }
	func enqueue(_ write: QueuedDecision) async throws {
		if fail { throw URLError(.cannotCreateFile) }
		lock.withLock { _writes.append(write) }
	}
}

private let payload = PushDecisionPayload(
	workspaceId: "ws-1", notificationId: "n-1", eventId: 42, objectId: "obj-1",
	options: [PushDecisionOption(label: "Ship it"), PushDecisionOption(label: "Hold")])

private func signedIn() -> InMemorySecretStore {
	let session = StoredSession(apiKey: "ank_test", actorId: "actor-1", name: "A", workspaceId: "ws-other")
	return InMemorySecretStore(try! JSONEncoder().encode(session))
}

private func handler(
	_ backend: FakeBackend, queue: FakeQueue = FakeQueue(), secrets: InMemorySecretStore = signedIn(),
	timeout: Duration = .seconds(5)
) -> NotificationActionHandler {
	NotificationActionHandler(
		secrets: secrets, backend: { _, _ in backend }, queue: queue, attemptTimeout: timeout)
}

@Suite("NotificationActionHandler")
struct NotificationActionHandlerTests {
	@Test func optionPostsTheLabelThreadedUnderTheDecisionThenMarksRead() async {
		let calls = Calls()
		let outcome = await handler(FakeBackend(calls: calls)).perform(
			.option(label: "Ship it"), userText: nil, payload: payload)
		#expect(outcome == .answered("Ship it"))
		#expect(await calls.comments.map(\.content) == ["Ship it"])
		#expect(await calls.comments.first?.parent == 42)
		#expect(await calls.comments.first?.entityId == "obj-1")
		#expect(await calls.reads.first?.1 == 42)
	}

	@Test func replyPostsTheTypedTextTrimmed() async {
		let calls = Calls()
		let outcome = await handler(FakeBackend(calls: calls)).perform(
			.reply, userText: "  Ship it Thursday \n", payload: payload)
		#expect(outcome == .answered("Ship it Thursday"))
		#expect(await calls.comments.first?.content == "Ship it Thursday")
	}

	@Test func emptyReplyIsRefusedWithoutAnyRequest() async {
		let calls = Calls()
		let outcome = await handler(FakeBackend(calls: calls)).perform(.reply, userText: "   ", payload: payload)
		#expect(outcome == .failed("Type a reply first."))
		#expect(await calls.comments.isEmpty)
	}

	@Test func writesCarryStableIdempotencyKeys() async {
		let a = Calls(), b = Calls()
		_ = await handler(FakeBackend(calls: a)).perform(.option(label: "Ship it"), userText: nil, payload: payload)
		_ = await handler(FakeBackend(calls: b)).perform(.option(label: "Ship it"), userText: nil, payload: payload)
		let ka = await a.comments.first?.key
		#expect(ka != nil)
		#expect(ka == (await b.comments.first?.key))
		#expect(ka != (await a.reads.first?.2))
		let c = Calls()
		_ = await handler(FakeBackend(calls: c)).perform(.option(label: "Hold"), userText: nil, payload: payload)
		#expect(await c.comments.first?.key != ka)
	}

	@Test func noSessionMeansNotSignedIn() async {
		let calls = Calls()
		let outcome = await handler(FakeBackend(calls: calls), secrets: InMemorySecretStore())
			.perform(.option(label: "Ship it"), userText: nil, payload: payload)
		#expect(outcome == .notSignedIn)
		#expect(await calls.comments.isEmpty)
	}

	@Test func offlineFailureIsQueuedDurably() async {
		let queue = FakeQueue()
		let backend = FakeBackend(calls: Calls(), commentError: URLError(.notConnectedToInternet))
		let outcome = await handler(backend, queue: queue).perform(
			.option(label: "Hold"), userText: nil, payload: payload)
		#expect(outcome == .queued("Hold"))
		let write = queue.writes.first
		#expect(write?.content == "Hold")
		#expect(write?.parentEventId == 42)
		#expect(write?.lastEventId == 42)
		#expect(write?.workspaceId == "ws-1")
		#expect(write?.entityId == "obj-1")
	}

	@Test func bothWritesShareOneDeadline() async {
		// Each write alone fits in the 400 ms budget; together they do not.
		let queue = FakeQueue()
		let calls = Calls()
		let outcome = await handler(
			FakeBackend(calls: calls, delay: .milliseconds(250)), queue: queue, timeout: .milliseconds(400)
		).perform(.option(label: "Ship it"), userText: nil, payload: payload)
		#expect(outcome == .answered("Ship it"))
		#expect(await calls.comments.count == 1)
		#expect(await calls.reads.isEmpty)
		// The mark-read that missed the deadline is owed to the outbox, with no second comment.
		#expect(queue.writes.count == 1)
		#expect(queue.writes.first?.content == nil)
	}

	@Test func postsTheFullOriginalLabelNeverAnEllipsis() async {
		let long = "Ship to ten percent of new workspaces first and watch activation closely"
		let p = PushDecisionPayload(
			workspaceId: "ws-1", notificationId: "n-1", eventId: 42, objectId: "obj-1",
			options: [PushDecisionOption(label: long), PushDecisionOption(label: "Hold")])
		let calls = Calls()
		let kind = NotificationActionPlan.choice(for: "maskin.option.0", in: p)
		let outcome = await handler(FakeBackend(calls: calls)).perform(
			try! #require(kind), userText: nil, payload: p)
		#expect(outcome == .answered(long))
		#expect(await calls.comments.first?.content == long)
		#expect(await calls.comments.first?.content.contains("\u{2026}") == false)
	}

	@Test func timeoutIsTreatedAsTransientAndQueued() async {
		let queue = FakeQueue()
		let outcome = await handler(FakeBackend(calls: Calls(), hang: true), queue: queue, timeout: .milliseconds(50))
			.perform(.option(label: "Hold"), userText: nil, payload: payload)
		#expect(outcome == .queued("Hold"))
		#expect(queue.writes.count == 1)
	}

	@Test func serverRejectionFailsAndIsNotQueued() async {
		let queue = FakeQueue()
		let backend = FakeBackend(
			calls: Calls(), commentError: OutboxRejection(status: 400, message: "The reply was rejected."))
		let outcome = await handler(backend, queue: queue).perform(
			.option(label: "Hold"), userText: nil, payload: payload)
		#expect(outcome == .failed("The reply was rejected."))
		#expect(queue.writes.isEmpty)
	}

	@Test func revokedKeyAsksToSignInAgain() async {
		let queue = FakeQueue()
		let backend = FakeBackend(calls: Calls(), commentError: OutboxAuthRequired(status: 401))
		let outcome = await handler(backend, queue: queue).perform(
			.option(label: "Hold"), userText: nil, payload: payload)
		#expect(outcome == .failed("Open Maskin and sign in again to send this."))
		#expect(queue.writes.isEmpty)
	}

	@Test func unsavableTransientFailureFails() async {
		let queue = FakeQueue()
		queue.fail = true
		let backend = FakeBackend(calls: Calls(), commentError: URLError(.timedOut))
		let outcome = await handler(backend, queue: queue).perform(
			.option(label: "Hold"), userText: nil, payload: payload)
		#expect(outcome == .failed("Couldn't send this. Open Maskin to answer."))
	}

	@Test func failedMarkReadStillCountsAsAnsweredAndOwesOnlyTheRead() async {
		let queue = FakeQueue()
		let calls = Calls()
		let backend = FakeBackend(calls: calls, readError: URLError(.networkConnectionLost))
		let outcome = await handler(backend, queue: queue).perform(
			.option(label: "Ship it"), userText: nil, payload: payload)
		#expect(outcome == .answered("Ship it"))
		#expect(await calls.comments.count == 1)
		#expect(queue.writes.count == 1)
		#expect(queue.writes.first?.content == nil)
		#expect(queue.writes.first?.lastEventId == 42)
	}
}
