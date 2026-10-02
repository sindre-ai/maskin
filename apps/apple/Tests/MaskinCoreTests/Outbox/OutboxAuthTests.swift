import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@MainActor
@Suite("Outbox holds on 401/403")
struct OutboxAuthTests {
	private func make(
		executor: ScriptedExecutor = ScriptedExecutor(), maxAttempts: Int = 1
	) -> Outbox {
		Outbox(
			fileURL: temporaryOutboxFile(), executor: executor, network: ManualNetworkMonitor(),
			workspaceId: { "ws-1" }, backoff: { _ in 3600 }, maxAttempts: maxAttempts)
	}

	@Test("a 401 keeps the entry, spends no attempts and drops nothing", arguments: [401, 403])
	func holds(status: Int) async throws {
		let executor = ScriptedExecutor()
		let outbox = make(executor: executor, maxAttempts: 1)
		// maxAttempts is 1: if this counted as an attempt the entry would be dropped.
		executor.fail(
			payload: "reply",
			with: [OutboxRejection(status: status, message: "no")])
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "reply", holdFor: 0)
		await outbox.drain()

		#expect(outbox.entries.count == 1)
		#expect(outbox.entries[0].attempts == 0)
		#expect(outbox.failures.isEmpty)
		#expect(outbox.isAuthBlocked)
	}

	@Test("an OutboxAuthRequired error holds every lane, not just the failing one")
	func holdsWholeQueue() async throws {
		let executor = ScriptedExecutor()
		let outbox = make(executor: executor)
		executor.fail(payload: "one", with: [OutboxAuthRequired(status: 401)])
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "one", holdFor: 0)
		await outbox.drain()
		try outbox.enqueue(kind: "t", lane: "b", summary: "s", payload: "two", holdFor: 0)
		await outbox.drain()
		#expect(outbox.isAuthBlocked)
		#expect(outbox.entries.count == 2)
		#expect(outbox.failures.isEmpty)
		#expect(executor.calls.map(\.payload) == ["one"], "nothing else is sent while held")
	}

	@Test("other 4xx are still permanent rejections")
	func otherClientErrorsDrop() async throws {
		let executor = ScriptedExecutor()
		let outbox = make(executor: executor)
		executor.fail(payload: "bad", with: [OutboxRejection(status: 422, message: "nope")])
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "bad")
		await outbox.drain()
		#expect(outbox.entries.isEmpty)
		#expect(outbox.failures.count == 1)
		#expect(!OutboxRejection.isPermanent(status: 401))
		#expect(!OutboxRejection.isPermanent(status: 403))
		#expect(OutboxRejection.isPermanent(status: 404))
	}

	@Test("stop() cancels triggers but keeps the queue and file")
	func stopKeeps() async throws {
		let outbox = make()
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "p", holdFor: 3600)
		outbox.stop()
		#expect(outbox.entries.count == 1)
		#expect(FileManager.default.fileExists(atPath: outbox.fileURLForTesting.path))
	}
}
