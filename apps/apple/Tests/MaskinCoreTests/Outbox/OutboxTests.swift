import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@MainActor
struct OutboxTests {
	private func makeOutbox(
		file: URL = temporaryOutboxFile(), executor: ScriptedExecutor = ScriptedExecutor(),
		network: ManualNetworkMonitor = ManualNetworkMonitor(), workspace: String? = "ws-1",
		maxAttempts: Int = 8
	) -> (Outbox, ScriptedExecutor, ManualNetworkMonitor, URL) {
		let outbox = Outbox(
			fileURL: file, executor: executor, network: network, workspaceId: { workspace },
			backoff: { _ in 0.02 }, maxAttempts: maxAttempts)
		return (outbox, executor, network, file)
	}

	@Test func sendsEnqueuedWriteWithItsIdempotencyKey() async throws {
		let (outbox, executor, _, _) = makeOutbox()
		let entry = try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "one")
		#expect(await eventually { outbox.entries.isEmpty })
		#expect(executor.calls.count == 1)
		#expect(executor.calls[0].key == entry.idempotencyKey)
	}

	@Test func persistsAcrossRestartAndReplaysWhenBackOnline() async throws {
		let file = temporaryOutboxFile()
		let offline = ManualNetworkMonitor(isOnline: false)
		let (first, firstExecutor, _, _) = makeOutbox(file: file, network: offline)
		let queued = try first.enqueue(kind: "t", lane: "a", summary: "s", payload: "one")
		await first.drain()
		#expect(firstExecutor.calls.isEmpty)  // offline: nothing sent, nothing lost
		#expect(FileManager.default.fileExists(atPath: file.path))

		// "Relaunch": a new outbox over the same file, now online.
		let (second, secondExecutor, _, _) = makeOutbox(file: file)
		#expect(second.entries.map(\.id) == [queued.id])
		await second.drain()
		#expect(secondExecutor.calls.map(\.payload) == ["one"])
		#expect(secondExecutor.calls[0].key == queued.idempotencyKey)
		#expect(second.entries.isEmpty)

		// And the emptied queue is what's persisted.
		let (third, _, _, _) = makeOutbox(file: file)
		#expect(third.entries.isEmpty)
	}

	@Test func replaysOnNetworkReturn() async throws {
		let offline = ManualNetworkMonitor(isOnline: false)
		let (outbox, executor, _, _) = makeOutbox(network: offline)
		outbox.start()
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "one")
		await outbox.drain()
		#expect(outbox.isOnline == false)
		#expect(executor.calls.isEmpty)
		offline.set(online: true)
		#expect(await eventually { outbox.entries.isEmpty })
		#expect(outbox.isOnline)
		#expect(executor.calls.count == 1)
	}

	@Test func keepsOrderWithinALane() async throws {
		let executor = ScriptedExecutor()
		// The first write fails once; the second must wait behind it.
		executor.fail(payload: "first", with: [URLError(.timedOut)])
		let (outbox, _, _, _) = makeOutbox(executor: executor)
		try outbox.enqueue(kind: "t", lane: "obj", summary: "1", payload: "first")
		try outbox.enqueue(kind: "t", lane: "obj", summary: "2", payload: "second")
		#expect(await eventually { outbox.entries.isEmpty })
		#expect(executor.calls.map(\.payload) == ["first", "first", "second"])
	}

	@Test func otherLanesAreNotBlockedByAFailingOne() async throws {
		let executor = ScriptedExecutor()
		executor.fail(payload: "stuck", with: [URLError(.timedOut), URLError(.timedOut)])
		let (outbox, _, _, _) = makeOutbox(executor: executor)
		try outbox.enqueue(kind: "t", lane: "a", summary: "a", payload: "stuck")
		try outbox.enqueue(kind: "t", lane: "b", summary: "b", payload: "free")
		#expect(await eventually { executor.calls.map(\.payload).contains("free") })
		#expect(await eventually { outbox.entries.isEmpty })
	}

	@Test func retriesReuseTheSameIdempotencyKey() async throws {
		let executor = ScriptedExecutor()
		executor.fail(payload: "one", with: [URLError(.networkConnectionLost), URLError(.badServerResponse)])
		let (outbox, _, _, _) = makeOutbox(executor: executor)
		let entry = try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "one")
		#expect(await eventually { outbox.entries.isEmpty })
		let keys = executor.calls.map(\.key)
		#expect(keys.count == 3)
		#expect(Set(keys) == [entry.idempotencyKey])
	}

	@Test func dropsAPermanentlyRejectedWriteAndItsGroup() async throws {
		let executor = ScriptedExecutor()
		executor.fail(payload: "comment", with: [OutboxRejection(status: 422, message: "Too long.")])
		let (outbox, _, _, _) = makeOutbox(executor: executor)
		var seen: [OutboxEvent] = []
		let stream = outbox.events()
		let collector = Task { @MainActor in for await e in stream { seen.append(e) } }

		try outbox.enqueue(kind: "t", lane: "a", groupId: "g", summary: "Your reply", payload: "comment")
		try outbox.enqueue(kind: "t", lane: "a", groupId: "g", summary: "Mark read", payload: "read")
		try outbox.enqueue(kind: "t", lane: "b", summary: "Other", payload: "other")
		#expect(await eventually { outbox.entries.isEmpty })

		#expect(executor.calls.map(\.payload).contains("read") == false)  // dependent never replayed alone
		#expect(executor.calls.map(\.payload).contains("other"))
		#expect(outbox.failures.count == 1)
		#expect(outbox.failures[0].summary == "Your reply")
		#expect(outbox.failures[0].message == "Too long.")
		#expect(await eventually { seen.count >= 3 })
		collector.cancel()
		#expect(seen.filter { if case .rejected = $0 { true } else { false } }.count == 2)

		// The user-visible failure survives a restart until dismissed.
		let (reloaded, _, _, file) = makeOutbox(file: outbox.fileURLForTesting)
		#expect(reloaded.failures.map(\.message) == ["Too long."])
		reloaded.dismissFailure(reloaded.failures[0].id)
		let (again, _, _, _) = makeOutbox(file: file)
		#expect(again.failures.isEmpty)
	}

	@Test func givesUpAfterMaxAttempts() async throws {
		let executor = ScriptedExecutor()
		executor.fail(payload: "one", with: Array(repeating: URLError(.badServerResponse), count: 10))
		let (outbox, _, _, _) = makeOutbox(executor: executor, maxAttempts: 2)
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "one")
		#expect(await eventually { !outbox.failures.isEmpty })
		#expect(outbox.entries.isEmpty)
		#expect(executor.calls.count == 2)
	}

	@Test func permanentStatusClassification() {
		#expect(OutboxRejection.isPermanent(status: 400))
		#expect(OutboxRejection.isPermanent(status: 404))
		#expect(OutboxRejection.isPermanent(status: 422))
		#expect(!OutboxRejection.isPermanent(status: 408))
		#expect(!OutboxRejection.isPermanent(status: 429))
		#expect(!OutboxRejection.isPermanent(status: 500))
		#expect(!OutboxRejection.isPermanent(status: 503))
	}

	@Test func holdDelaysSendingAndCancelRemovesGroup() async throws {
		let (outbox, executor, _, _) = makeOutbox()
		try outbox.enqueue(kind: "t", lane: "a", groupId: "g", summary: "s", payload: "held", holdFor: 60)
		await outbox.drain()
		#expect(executor.calls.isEmpty)
		#expect(outbox.pendingCount == 1)
		#expect(outbox.cancel(groupId: "g"))
		#expect(outbox.entries.isEmpty)
		#expect(executor.calls.isEmpty)
	}

	@Test func holdExpiresOnItsOwn() async throws {
		let (outbox, executor, _, _) = makeOutbox()
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "soon", holdFor: 0.15)
		#expect(executor.calls.isEmpty)
		#expect(await eventually { outbox.entries.isEmpty })
		#expect(executor.calls.count == 1)
	}

	@Test func releaseHoldsSendsEverythingNow() async throws {
		let (outbox, executor, _, _) = makeOutbox()
		try outbox.enqueue(kind: "t", lane: "a", summary: "s", payload: "held", holdFor: 60)
		outbox.releaseHolds()
		#expect(await eventually { outbox.entries.isEmpty })
		#expect(executor.calls.count == 1)
	}

	@Test func concurrentDrainsSendEachWriteOnce() async throws {
		let (outbox, executor, _, _) = makeOutbox()
		for i in 0..<5 { try outbox.enqueue(kind: "t", lane: "lane-\(i)", summary: "s", payload: "p\(i)") }
		async let a: Void = outbox.drain()
		async let b: Void = outbox.drain()
		async let c: Void = outbox.drain()
		_ = await (a, b, c)
		#expect(await eventually { outbox.entries.isEmpty })
		#expect(executor.calls.count == 5)
		#expect(Set(executor.calls.map(\.payload)).count == 5)
	}

	@Test func entriesForAnotherWorkspaceWait() async throws {
		let file = temporaryOutboxFile()
		let (writer, _, _, _) = makeOutbox(
			file: file, network: ManualNetworkMonitor(isOnline: false), workspace: "ws-1")
		try writer.enqueue(kind: "t", lane: "a", summary: "s", payload: "mine")

		let (wrongWorkspace, wrongExecutor, _, _) = makeOutbox(file: file, workspace: "ws-2")
		await wrongWorkspace.drain()
		#expect(wrongExecutor.calls.isEmpty)
		#expect(wrongWorkspace.entries.count == 1)

		let (rightWorkspace, rightExecutor, _, _) = makeOutbox(file: file, workspace: "ws-1")
		await rightWorkspace.drain()
		#expect(rightExecutor.calls.map(\.payload) == ["mine"])
	}
}
