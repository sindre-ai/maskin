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
}
