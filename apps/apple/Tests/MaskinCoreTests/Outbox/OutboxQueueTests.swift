import Foundation
import Testing

@testable import MaskinCore

/// The offline banner's "View" list: which sections it shows, in what order, and what a failed
/// write offers.
@MainActor
struct OutboxQueueTests {
	private func makeOutbox(
		executor: ScriptedExecutor = ScriptedExecutor(), online: Bool = true,
		now: @escaping @Sendable () -> Date = { Date() }
	) -> Outbox {
		Outbox(
			fileURL: temporaryOutboxFile(), executor: executor,
			network: ManualNetworkMonitor(isOnline: online), workspaceId: { "ws-1" },
			now: now, backoff: { _ in 0.02 })
	}

	/// An outbox whose write for `payload` was refused by the server, so it sits in `failures`.
	private func outboxWithFailure(summary: String, payload: String) async throws -> Outbox {
		let executor = ScriptedExecutor()
		executor.fail(payload: payload, with: [OutboxRejection(status: 422, message: "Too long.")])
		let outbox = makeOutbox(executor: executor)
		try outbox.enqueue(kind: "t", lane: payload, summary: summary, payload: payload)
		#expect(await eventually { !outbox.failures.isEmpty })
		return outbox
	}

	@Test func emptyQueueShowsNoSections() {
		let queue = OutboxQueue(outboxes: [makeOutbox(), makeOutbox()])
		#expect(queue.sections.isEmpty)
	}

	@Test func waitingWritesShowOnlyTheWaitingSection() throws {
		let outbox = makeOutbox(online: false)
		try outbox.enqueue(kind: "t", lane: "a", summary: "Your reply", payload: "one")
		let queue = OutboxQueue(outboxes: [outbox])
		#expect(queue.sections == [.waiting])
	}

	@Test func aFailedWriteShowsOnlyTheCouldNotSendSection() async throws {
		let outbox = try await outboxWithFailure(summary: "Your reply", payload: "long")
		let queue = OutboxQueue(outboxes: [outbox])
		#expect(queue.sections == [.couldNotSend])
	}

	@Test func waitingAndFailedWritesShowBothSectionsWaitingFirst() async throws {
		let failed = try await outboxWithFailure(summary: "Your reply", payload: "long")
		let waiting = makeOutbox(online: false)
		try waiting.enqueue(kind: "t", lane: "b", summary: "Your note", payload: "two")
		let queue = OutboxQueue(outboxes: [failed, waiting])
		#expect(queue.sections == [.waiting, .couldNotSend])
	}

	@Test func aFailureOffersDismissOnly() async throws {
		let outbox = try await outboxWithFailure(summary: "Your reply", payload: "long")
		let queue = OutboxQueue(outboxes: [outbox])
		#expect(queue.choices(for: queue.failures[0]) == [.dismiss])
	}

	@Test func dismissRemovesOnlyThatFailureAndLeavesTheRest() async throws {
		let first = try await outboxWithFailure(summary: "Your reply", payload: "long")
		let second = try await outboxWithFailure(summary: "Your note", payload: "other")
		let queue = OutboxQueue(outboxes: [first, second])
		let reply = try #require(queue.failures.first { $0.summary == "Your reply" })

		queue.perform(.dismiss, on: reply)

		#expect(queue.failures.map(\.summary) == ["Your note"])
		#expect(first.failures.isEmpty)
		#expect(second.failures.count == 1)
		#expect(queue.sections == [.couldNotSend])
	}

	@Test func dismissingTheLastFailureEmptiesTheList() async throws {
		let outbox = try await outboxWithFailure(summary: "Your reply", payload: "long")
		let queue = OutboxQueue(outboxes: [outbox])
		queue.perform(.dismiss, on: queue.failures[0])
		#expect(queue.sections.isEmpty)
	}

	@Test func dismissedFailureStaysGoneAfterRelaunch() async throws {
		let executor = ScriptedExecutor()
		executor.fail(payload: "long", with: [OutboxRejection(status: 422, message: "Too long.")])
		let file = temporaryOutboxFile()
		let make = {
			Outbox(
				fileURL: file, executor: executor, network: ManualNetworkMonitor(), workspaceId: { "ws-1" },
				backoff: { _ in 0.02 })
		}
		let outbox = make()
		try outbox.enqueue(kind: "t", lane: "a", summary: "Your reply", payload: "long")
		#expect(await eventually { !outbox.failures.isEmpty })
		let queue = OutboxQueue(outboxes: [outbox])
		queue.perform(.dismiss, on: queue.failures[0])
		#expect(OutboxQueue(outboxes: [make()]).sections.isEmpty)
	}

	@Test func waitingReadsOldestFirstAcrossOutboxes() throws {
		let clock = StepClock()
		let a = makeOutbox(online: false, now: { clock.now })
		let b = makeOutbox(online: false, now: { clock.now })
		try a.enqueue(kind: "t", lane: "a", summary: "first", payload: "1")
		clock.advance(1)
		try b.enqueue(kind: "t", lane: "b", summary: "second", payload: "2")
		clock.advance(1)
		try a.enqueue(kind: "t", lane: "a", summary: "third", payload: "3")
		let queue = OutboxQueue(outboxes: [b, a])
		#expect(queue.entries.map(\.summary) == ["first", "second", "third"])
	}
}
