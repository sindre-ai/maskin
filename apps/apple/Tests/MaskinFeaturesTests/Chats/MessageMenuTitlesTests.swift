import Testing

@testable import MaskinFeatures

@Suite("MessageMenuActions")
struct MessageMenuTitlesTests {
	@Test("Select text sits after Copy when the message has text")
	func selectTextAfterCopy() {
		var actions = MessageMenuActions()
		actions.onCopy = {}
		actions.onSelectText = {}
		actions.onPin = {}
		#expect(actions.titles == ["Copy", "Select text", "Pin"])
	}

	@Test("an agent's plain words offer Open <agent>, after Select text")
	func openAgent() {
		var actions = MessageMenuActions()
		actions.onCopy = {}
		actions.onSelectText = {}
		actions.onOpenAgent = {}
		actions.openAgentTitle = "Open Relay"
		actions.onPin = {}
		#expect(actions.titles == ["Copy", "Select text", "Open Relay", "Pin"])
	}

	@Test("no Select text for a message without text")
	func noSelectTextWithoutText() {
		var actions = MessageMenuActions()
		actions.onPin = {}
		#expect(!actions.titles.contains("Select text"))
	}
}
