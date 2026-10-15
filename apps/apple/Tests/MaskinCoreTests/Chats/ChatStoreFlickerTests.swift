import Foundation
import Observation
import Testing

@testable import MaskinCore

/// The thread flickered in a loop while an agent with a live handoff row was busy: every session
/// event in the workspace re-read the thread and re-published it, unchanged, to the view.
@Suite("ChatStore event storms")
@MainActor
struct ChatStoreFlickerTests {
	private func liveParent() -> ChatMessage {
		var parent = chatMsg(1, by: "relay", agent: true, "handing off")
		parent.spawnedSessions = [
			SpawnedSession(id: "sub1", status: "running", actorID: "dev", actorName: "Dev", actionPrompt: "Fix it")
		]
		return parent
	}

	private func frames(_ ids: [String]) -> String {
		ids.enumerated().map { conversationFrame($0.offset + 10, conversation: $0.element, action: "updated", entity: "session") }
			.joined()
	}

	@Test("session events for unrelated sessions never re-read the thread")
	func unrelatedSessionsAreIgnored() async {
		let hub = scriptedHub([frames(Array(repeating: "someone-elses", count: 30))])
		let h = ChatHarness(server: [liveParent()], events: hub)
		await h.store.start()
		let before = await h.api.messageCalls.count
		hub.connect(workspaceId: "w1")
		try? await Task.sleep(for: .milliseconds(300))
		// One read is the stream's own reconnect; the 30 session events add none.
		#expect(await h.api.messageCalls.count - before <= 1)
		h.store.stop()
	}

	@Test("a burst of events for this thread's own session coalesces into a few reads")
	func ownSessionBurstIsCoalesced() async {
		let hub = scriptedHub([frames(Array(repeating: "sub1", count: 30))])
		let h = ChatHarness(server: [liveParent()], events: hub)
		await h.store.start()
		let before = await h.api.messageCalls.count
		hub.connect(workspaceId: "w1")
		try? await Task.sleep(for: .milliseconds(400))
		#expect(await h.api.messageCalls.count - before <= 3)
		h.store.stop()
	}

	@Test("re-reading an unchanged thread does not republish the messages")
	func unchangedSyncIsSilent() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "hi"), chatMsg(2, by: "relay", agent: true, "again")])
		await h.store.start()
		let fired = Atomic()
		withObservationTracking {
			_ = h.store.messages
		} onChange: {
			fired.set()
		}
		await h.store.sync(full: true)
		#expect(!fired.value)
	}
}

private final class Atomic: @unchecked Sendable {
	private let lock = NSLock()
	private var flag = false
	func set() { lock.lock(); flag = true; lock.unlock() }
	var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
}
