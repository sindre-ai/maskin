import Foundation
import Testing

@testable import MaskinCore

@Suite("UndoSendHold")
@MainActor
struct UndoSendHoldTests {
	/// A window long enough that the timer never fires inside a test.
	private func longHold() -> UndoSendHold { UndoSendHold(window: .seconds(60)) }

	@Test("sends nothing while held, and the bar is up")
	func holds() {
		let hold = longHold()
		var sent = 0
		hold.hold(send: { sent += 1 }, restore: {})
		#expect(hold.isHeld)
		#expect(sent == 0)
	}

	@Test("undo restores the message and never sends it")
	func undo() {
		let hold = longHold()
		var sent = 0
		var restored = 0
		hold.hold(send: { sent += 1 }, restore: { restored += 1 })
		hold.undo()
		hold.flush()
		#expect(restored == 1)
		#expect(sent == 0)
		#expect(!hold.isHeld)
	}

	@Test("the message goes out when the window ends")
	func windowEnds() async throws {
		let hold = UndoSendHold(window: .milliseconds(20))
		var sent = 0
		hold.hold(send: { sent += 1 }, restore: {})
		try await Task.sleep(for: .milliseconds(300))
		#expect(sent == 1)
		#expect(!hold.isHeld)
	}

	@Test("flush sends at once, once")
	func flush() {
		let hold = longHold()
		var sent = 0
		hold.hold(send: { sent += 1 }, restore: {})
		hold.flush()
		hold.flush()
		#expect(sent == 1)
		#expect(!hold.isHeld)
	}

	@Test("holding another message sends the first one first, in order")
	func order() {
		let hold = longHold()
		var order: [String] = []
		hold.hold(send: { order.append("first") }, restore: {})
		hold.hold(send: { order.append("second") }, restore: {})
		hold.flush()
		#expect(order == ["first", "second"])
	}

	@Test("an old window cannot send a newer message early")
	func staleTimer() async throws {
		let hold = UndoSendHold(window: .milliseconds(150))
		var order: [String] = []
		hold.hold(send: { order.append("first") }, restore: {})
		hold.undo()
		hold.hold(send: { order.append("second") }, restore: {})
		try await Task.sleep(for: .milliseconds(60))
		#expect(order.isEmpty)
		try await Task.sleep(for: .milliseconds(400))
		#expect(order == ["second"])
	}
}
