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

	@Test("Reply in thread is the only reply row, first in the menu")
	func threadIsTheOnlyReply() {
		var actions = MessageMenuActions()
		actions.onThread = {}
		actions.onCopy = {}
		#expect(actions.titles == ["Reply in thread", "Copy"])
		#expect(!actions.titles.contains("Reply"))
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

	@Test("an agent named like an action cannot hijack it: rows run by identity, not by title")
	func titleCollision() {
		final class Calls { var copy = 0, open = 0 }
		let calls = Calls()
		var actions = MessageMenuActions()
		actions.onCopy = { calls.copy += 1 }
		actions.onOpenAgent = { calls.open += 1 }
		actions.openAgentTitle = "Copy"
		#expect(actions.titles == ["Copy", "Copy"])
		let items = actions.entries.map(\.item)
		#expect(items == [.copy, .openAgent])
		actions.run(items[0])
		#expect(calls.copy == 1 && calls.open == 0)
		actions.run(items[1])
		#expect(calls.copy == 1 && calls.open == 1)
	}

	@Test("no Select text for a message without text")
	func noSelectTextWithoutText() {
		var actions = MessageMenuActions()
		actions.onPin = {}
		#expect(!actions.titles.contains("Select text"))
	}

	@Test("the sheet opens only when the menu has rows")
	func sheetNeedsRows() {
		var actions = MessageMenuActions()
		#expect(!actions.hasItems)
		actions.onReact = { _ in }
		#expect(actions.hasItems)
		actions.onReact = nil
		actions.onCopy = {}
		#expect(actions.hasItems)
	}

	@Test("Reply in thread and Copy are the tiles, the rest are grouped, Delete is last")
	func sheetLayout() {
		var actions = MessageMenuActions()
		actions.onThread = {}
		actions.onCopy = {}
		actions.onSelectText = {}
		actions.onPin = {}
		actions.onTryAgain = {}
		actions.onShorter = {}
		actions.onRetrySend = {}
		actions.onDiscard = {}
		#expect(actions.tiles.map(\.title) == ["Reply in thread", "Copy"])
		#expect(actions.groups.map { $0.map(\.title) } == [
			["Select text", "Pin"], ["Try again", "Make it shorter"], ["Retry", "Delete"],
		])
	}

	@Test("an empty group leaves no group, and the tiles never repeat as rows")
	func sheetSkipsEmptyGroups() {
		var actions = MessageMenuActions()
		actions.onCopy = {}
		actions.onDiscard = {}
		#expect(actions.tiles.map(\.title) == ["Copy"])
		#expect(actions.groups.map { $0.map(\.title) } == [["Delete"]])
	}
}
