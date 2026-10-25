import Foundation
import Testing

@testable import MaskinCore

/// The Chief of Staff sheet sends its opening message from `.task`, before the thread has loaded
/// anything, so the send knows no newest server id.
@Suite("ChatStore send before the thread has loaded")
@MainActor
struct ChatStoreSendBeforeLoadTests {
	@Test("a queued message is not hidden by an older identical one loaded after it was sent")
	func olderTwinDoesNotHideQueued() async {
		let h = ChatHarness(server: [chatMsg(1, by: "me", "ok")], online: false)
		h.store.send("ok")
		await h.store.start()
		#expect(h.store.messages.count == 2)
		#expect(h.store.messages.last?.status == .waiting("Waiting for a connection"))
	}

	@Test("a message delivered while the first page is still in flight stays in the thread")
	func deliveredDuringLoad() async {
		let h = ChatHarness(server: [chatMsg(1, by: "me", "ok"), chatMsg(2, by: "relay", agent: true, "hello")])
		let gate = PageGate()
		await h.api.setMessagesGate { await gate.wait() }
		let store = h.store
		let loading = Task { await store.start() }
		await Task.yield()
		h.store.send("ok")
		#expect(await h.settled())
		await gate.open()
		await loading.value
		#expect(h.store.messages.compactMap(\.serverID) == [1, 2, 3])
	}
}

private actor PageGate {
	private var isOpen = false
	private var waiters: [CheckedContinuation<Void, Never>] = []
	func wait() async {
		if isOpen { return }
		await withCheckedContinuation { waiters.append($0) }
	}
	func open() {
		isOpen = true
		for w in waiters { w.resume() }
		waiters = []
	}
}
