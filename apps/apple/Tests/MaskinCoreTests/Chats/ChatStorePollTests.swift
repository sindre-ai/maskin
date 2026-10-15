import Foundation
import Testing

@testable import MaskinCore

/// Messages normally arrive on the event stream. A reply that the stream never announced (it
/// dropped, or the app was "inactive" behind a screen recording) must still reach the thread.
@Suite("ChatStore reply polling")
@MainActor
struct ChatStorePollTests {
	@Test("an agent reply no event announced still arrives while the app is inactive")
	func replyArrivesWithoutAnEvent() async {
		let h = ChatHarness(
			server: [chatMsg(1, by: "relay", agent: true, "hi")], pollInterval: .milliseconds(40))
		await h.store.start()
		h.store.isActive = false
		h.store.send("check my email")
		#expect(await h.settled())
		await h.api.append(chatMsg(3, by: "relay", agent: true, "found it"))
		let arrived = await eventually { h.store.messages.contains { $0.content == "found it" } }
		#expect(arrived)
		h.store.stop()
	}

	@Test("a sent bubble stays until the server's copy is in the thread, even if the delivery hand-off is skipped")
	func bubbleSurvivesAMissedHandOff() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "hi")])
		await h.store.start()
		// A response the store can't match to this thread: the inline hand-off is skipped, the outbox
		// drops its entry, and nothing but the store's own memory is left to draw the bubble.
		await h.api.setResponseConversationID("someone-else")
		h.store.send("hello")
		#expect(await h.settled())
		#expect(h.store.messages.filter { $0.content == "hello" }.count == 1)
		// The next read brings the confirmed copy; the bubble must not double up.
		await h.store.sync()
		let hello = h.store.messages.filter { $0.content == "hello" }
		#expect(hello.count == 1)
		#expect(hello.first?.serverID != nil)
	}
}
