import Foundation
import Testing

@testable import MaskinCore

final class FakeDecisionBackend: DecisionBackend, @unchecked Sendable {
	private let lock = NSLock()
	private var log: [String] = []
	private var _commentError: (any Error)?

	var commentError: (any Error)? {
		get { lock.withLock { _commentError } }
		set { lock.withLock { _commentError = newValue } }
	}

	var calls: [String] { lock.withLock { log } }

	func postComment(entityId: String, content: String, parentEventId: Int?) async throws {
		let error: (any Error)? = lock.withLock {
			log.append("comment:\(entityId):\(content):\(parentEventId.map(String.init) ?? "-")")
			return _commentError
		}
		if let error { throw error }
	}

	func markRead(entityId: String, lastEventId: Int) async throws {
		lock.withLock { log.append("read:\(entityId):\(lastEventId)") }
	}

	func markUnread(entityId: String) async throws {
		lock.withLock { log.append("unread:\(entityId)") }
	}
}

@MainActor
struct DecisionServiceTests {
	private func make(
		window: TimeInterval = 0.2, online: Bool = true, file: URL = temporaryOutboxFile()
	) -> (DecisionService, Outbox, FakeDecisionBackend, ManualNetworkMonitor) {
		let backend = FakeDecisionBackend()
		let network = ManualNetworkMonitor(isOnline: online)
		let outbox = Outbox(
			fileURL: file, executor: DecisionOutboxExecutor(backend: backend), network: network,
			workspaceId: { "ws-1" }, backoff: { _ in 0.02 })
		return (DecisionService(outbox: outbox, undoWindow: window), outbox, backend, network)
	}

	private let target = DecisionTarget(entityId: "obj-1", parentEventId: 42, latestEventId: 99)

	@Test func choosingShowsAHeldReceiptBeforeAnythingIsSent() async {
		let (service, _, backend, _) = make(window: 60)
		service.choose("Hold", on: target)
		let record = service.record(for: "obj-1")
		#expect(record?.kind == .option("Hold"))
		if case .held = record?.phase {} else { Issue.record("expected held, got \(String(describing: record?.phase))") }
		#expect(service.canUndo("obj-1"))
		try? await Task.sleep(for: .milliseconds(50))
		#expect(backend.calls.isEmpty)
	}

	@Test func sendsCommentThenMarkReadAfterTheWindow() async {
		let (service, _, backend, _) = make()
		service.choose("Approve", on: target)
		#expect(await eventually { service.record(for: "obj-1")?.phase == .sent })
		#expect(backend.calls == ["comment:obj-1:Approve:42", "read:obj-1:99"])
		#expect(service.record(for: "obj-1")?.staysUnread == false)
		#expect(!service.canUndo("obj-1"))  // an answer cannot be taken back once sent
		#expect(!service.undo("obj-1"))
	}

	@Test func undoInsideTheWindowSendsNothing() async {
		let (service, outbox, backend, _) = make(window: 0.4)
		service.choose("Approve", on: target)
		#expect(service.undo("obj-1"))
		#expect(service.record(for: "obj-1") == nil)
		#expect(outbox.entries.isEmpty)
		try? await Task.sleep(for: .milliseconds(600))
		#expect(backend.calls.isEmpty)
	}

	@Test func rejectionRollsBackAndNeverMarksTheThreadRead() async {
		let (service, _, backend, _) = make()
		backend.commentError = OutboxRejection(status: 422, message: "Reply too long.")
		service.reply("hello", on: target)
		#expect(await eventually {
			if case .failed = service.record(for: "obj-1")?.phase { true } else { false }
		})
		#expect(service.record(for: "obj-1")?.phase == .failed("Reply too long."))
		#expect(backend.calls == ["comment:obj-1:hello:42"])  // mark-read dropped with its group
	}

	@Test func offlineDecisionIsQueuedThenSentOnReturn() async {
		let (service, outbox, backend, network) = make(online: false)
		outbox.start()
		service.choose("Approve", on: target)
		#expect(await eventually { service.record(for: "obj-1")?.phase == .queued })
		#expect(backend.calls.isEmpty)
		network.set(online: true)
		#expect(await eventually { service.record(for: "obj-1")?.phase == .sent })
		#expect(backend.calls == ["comment:obj-1:Approve:42", "read:obj-1:99"])
	}

	@Test func replyWithoutAHighWaterMarkStaysUnread() async {
		let (service, _, backend, _) = make()
		service.reply("  on it  ", on: DecisionTarget(entityId: "obj-2", parentEventId: nil, latestEventId: nil))
		#expect(service.record(for: "obj-2")?.staysUnread == true)
		#expect(await eventually { service.record(for: "obj-2")?.phase == .sent })
		#expect(backend.calls == ["comment:obj-2:on it:-"])
	}

	@Test func blankReplyIsIgnored() {
		let (service, outbox, _, _) = make()
		service.reply("   \n", on: target)
		#expect(service.record(for: "obj-1") == nil)
		#expect(outbox.entries.isEmpty)
	}

	@Test func dismissingMarksReadAndCanBeUndoneEvenAfterSending() async {
		let (service, _, backend, _) = make(window: 0.1)
		service.markRead(target)
		#expect(service.record(for: "obj-1")?.kind == .dismissed)
		#expect(await eventually { service.record(for: "obj-1")?.phase == .sent })
		#expect(backend.calls == ["read:obj-1:99"])
		#expect(service.canUndo("obj-1"))
		#expect(service.undo("obj-1"))
		#expect(await eventually { backend.calls.contains("unread:obj-1") })
		#expect(service.record(for: "obj-1") == nil)
	}

	@Test func answeringAgainSupersedesAFailedAttempt() async {
		let (service, _, backend, _) = make(window: 0.05)
		backend.commentError = OutboxRejection(status: 400, message: "No.")
		service.choose("Hold", on: target)
		#expect(await eventually {
			if case .failed = service.record(for: "obj-1")?.phase { true } else { false }
		})
		backend.commentError = nil
		service.choose("Approve", on: target)
		#expect(await eventually { service.record(for: "obj-1")?.phase == .sent })
		#expect(service.record(for: "obj-1")?.kind == .option("Approve"))
	}

	@Test func commitHeldSendsWithoutWaitingForTheWindow() async {
		let (service, _, backend, _) = make(window: 60)
		service.choose("Approve", on: target)
		service.commitHeld()
		#expect(await eventually { backend.calls.count == 2 })
	}
}
