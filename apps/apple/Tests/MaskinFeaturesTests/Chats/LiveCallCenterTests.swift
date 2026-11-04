import Testing

@testable import MaskinFeatures

@MainActor
@Suite("LiveCallCenter panel tracking") struct LiveCallCenterTests {
	@Test("a panel on screen is counted, and gone when it disappears")
	func appearsAndDisappears() {
		let center = LiveCallCenter()
		#expect(!center.isPanelOnScreen(for: "chat-1"))
		center.panelAppeared(for: "chat-1")
		#expect(center.isPanelOnScreen(for: "chat-1"))
		center.panelDisappeared(for: "chat-1")
		#expect(!center.isPanelOnScreen(for: "chat-1"))
	}

	@Test("the old panel disappearing after the new one appeared does not hide the new one")
	func overlappingInstances() {
		let center = LiveCallCenter()
		center.panelAppeared(for: "chat-1")  // the thread already on screen
		center.panelAppeared(for: "chat-1")  // the same thread pushed again
		center.panelDisappeared(for: "chat-1")  // the old copy goes
		#expect(center.isPanelOnScreen(for: "chat-1"))
		center.panelDisappeared(for: "chat-1")
		#expect(!center.isPanelOnScreen(for: "chat-1"))
	}

	@Test("panels of different conversations do not affect each other")
	func separateConversations() {
		let center = LiveCallCenter()
		center.panelAppeared(for: "chat-1")
		#expect(!center.isPanelOnScreen(for: "chat-2"))
		center.panelDisappeared(for: "chat-2")  // a stray disappear never goes below zero
		center.panelAppeared(for: "chat-2")
		#expect(center.isPanelOnScreen(for: "chat-2"))
	}

	@Test("with no call running there is no pill")
	func noCallNoPill() {
		#expect(!LiveCallCenter().showsPill)
	}
}
