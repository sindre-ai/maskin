import Testing

@testable import MaskinFeatures

@Suite("ShellCommands")
struct ShellCommandsTests {
	@Test func numberShortcutsCoverEveryTabExceptSearchInOrder() {
		#expect(ShellCommands.shortcutTabs == [.forYou, .chats, .loops, .objects])
	}

	@Test func numberShortcutsStayWithinSingleDigits() {
		#expect(ShellCommands.shortcutTabs.count <= 9)
	}
}
