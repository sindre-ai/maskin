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

	@MainActor @Test func theNewMessageQuickActionOpensTheNewConversationSheetOnTeam() {
		let runtime = AppRuntime(environment: .preview())
		runtime.selectedTab = .objects
		runtime.presentation = .settings
		runtime.perform(.newMessage)
		#expect(runtime.selectedTab == .chats)
		#expect(runtime.presentation == nil)
		#expect(runtime.newConversationRequested)
	}

	@MainActor @Test func theForYouQuickActionOpensForYouFromAnyTab() {
		let runtime = AppRuntime(environment: .preview())
		runtime.selectedTab = .chats
		runtime.presentation = .settings
		runtime.perform(.forYou)
		#expect(runtime.selectedTab == .forYou)
		#expect(runtime.presentation == nil)
		#expect(!runtime.newConversationRequested)
	}

	@MainActor @Test func searchOpensAsASheetAndKeepsTheTab() {
		let runtime = AppRuntime(environment: .preview())
		runtime.selectedTab = .objects
		runtime.selectedTab = .search
		#expect(runtime.selectedTab == .objects)
		#expect(runtime.presentation == .search)
	}

	@MainActor @Test func theTabBarPlusStartsAChiefOfStaffChatAndStaysOnChats() {
		let runtime = AppRuntime(environment: .preview())
		runtime.selectedTab = .objects
		runtime.presentation = .settings
		runtime.selectedTab = .newChat
		#expect(runtime.selectedTab == .chats)
		#expect(runtime.presentation == nil)
		#expect(runtime.chiefChatRequested)
	}
}
