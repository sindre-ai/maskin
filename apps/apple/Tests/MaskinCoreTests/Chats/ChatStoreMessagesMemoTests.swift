import Foundation
import Observation
import Testing

@testable import MaskinCore

private final class ChangeFlag: @unchecked Sendable {
	private let lock = NSLock()
	private var value = false
	var isSet: Bool { lock.withLock { value } }
	func set() { lock.withLock { value = true } }
}

/// `ChatStore.messages` is built once and served from a memo (the thread view reads it hundreds of
/// times a render); these pin down that it is rebuilt, and observers told, whenever its inputs change.
@Suite("ChatStore messages memo")
@MainActor
struct ChatStoreMessagesMemoTests {
	@Test("many reads of an unchanged thread build the list once")
	func readsAreServedFromTheMemo() async {
		let h = ChatHarness(server: (1...5).map { chatMsg($0) })
		await h.store.start()
		_ = h.store.messages
		let before = h.store.messageBuilds
		for _ in 0..<300 { _ = h.store.messages }
		#expect(h.store.messageBuilds == before)
	}

	@Test("sending shows the new bubble at once, and a reader of the memo is told")
	func aSendInvalidatesTheMemo() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true)], online: false)
		await h.store.start()
		#expect(h.store.messages.count == 1)  // memoised

		let told = ChangeFlag()
		withObservationTracking { _ = h.store.messages } onChange: { told.set() }
		_ = h.store.send("hello")
		#expect(told.isSet)
		#expect(h.store.messages.count == 2)
		#expect(h.store.messages.last?.content == "hello")
	}

	@Test("a page of earlier history invalidates it")
	func loadingEarlierInvalidatesTheMemo() async {
		let h = ChatHarness(server: (1...7).map { chatMsg($0) }, pageSize: 3)
		await h.store.start()
		#expect(h.store.messages.compactMap(\.serverID) == [5, 6, 7])
		await h.store.loadEarlier()
		#expect(h.store.messages.compactMap(\.serverID) == [2, 3, 4, 5, 6, 7])
	}

	@Test("a delivered send replaces its queued bubble without a stale copy")
	func deliveryInvalidatesTheMemo() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true)])
		await h.store.start()
		let id = h.store.send("hi there")
		#expect(h.store.messages.last?.status == .sending)
		#expect(await h.settled())
		#expect(h.store.messages.count == 2)
		#expect(h.store.messages.last?.id == id)
		#expect(h.store.messages.last?.status == .sent)
	}

	@Test("going offline changes a queued bubble's status in the memoised list")
	func outboxStateChangesInvalidateTheMemo() async {
		let h = ChatHarness(online: true)
		await h.store.start()
		_ = h.store.send("queued")
		_ = h.store.messages
		let flag = ChangeFlag()
		withObservationTracking { _ = h.store.messages } onChange: { flag.set() }
		h.network.set(online: false)
		#expect(await eventually { flag.isSet })
	}
}
