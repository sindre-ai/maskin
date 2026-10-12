import MaskinCore
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

	@MainActor @Test func newConversationOpensTeamFromAnyTab() {
		let runtime = AppRuntime(environment: .preview())
		runtime.selectedTab = .objects
		runtime.presentation = .settings
		runtime.requestNewConversation()
		#expect(runtime.selectedTab == .chats)
		#expect(runtime.presentation == nil)
		#expect(runtime.newConversationRequested)
	}
}
