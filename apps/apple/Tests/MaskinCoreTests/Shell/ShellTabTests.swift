import Foundation
import Testing

@testable import MaskinCore

@Suite("ShellTab")
struct ShellTabTests {
	@Test func fourTabsThenTheNewChatButtonInOrder() {
		#expect(ShellTab.allCases == [.forYou, .chats, .loops, .objects, .search, .newChat])
		#expect(ShellTab.primary == [.forYou, .chats, .loops, .objects])
	}

	@Test func titlesUseTeamAndFlows() {
		#expect(ShellTab.allCases.map(\.title) == ["For you", "Chats", "Flows", "Items", "Search", "New chat with Chief of Staff"])
	}

	@Test func barItemsPerTab() {
		#expect(ShellTab.forYou.barItems == [.live, .avatar])
		#expect(ShellTab.chats.barItems == [.search, .display, .new, .avatar])
		#expect(ShellTab.loops.barItems == [.marketplace, .display, .avatar])
		#expect(ShellTab.objects.barItems == [.search, .display, .avatar])
	}

	@Test func everyTabHasTheAvatar() {
		for tab in ShellTab.allCases { #expect(tab.barItems.last == .avatar) }
	}

	@Test func onlyTeamHasNewAndOnlyForYouHasLive() {
		for tab in ShellTab.allCases {
			#expect(tab.barItems.contains(.new) == (tab == .chats))
			#expect(tab.barItems.contains(.live) == (tab == .forYou))
		}
	}

	@Test func displayAndAvatarStayOnScroll() {
		#expect(!ShellBarItem.display.collapsesOnScroll)
		#expect(!ShellBarItem.avatar.collapsesOnScroll)
		#expect(ShellBarItem.new.collapsesOnScroll)
	}
}

@Suite("ProfileMenu")
struct ProfileMenuTests {
	@Test func fourSectionsInOrder() {
		#expect(ProfileMenuGroup.allCases.map(\.title) == ["Account", "Workspace", "Agents and access", "Admin"])
		#expect(
			ProfileMenu.items(in: .account, hasWorkspace: true).map(\.title)
				== ["Settings", "Account", "Billing", "Notifications", "App lock", "Sign in a device"])
		#expect(
			ProfileMenu.items(in: .workspace, hasWorkspace: true).map(\.title)
				== ["Agents", "Members", "Integrations", "Triggers"])
		#expect(
			ProfileMenu.items(in: .access, hasWorkspace: true).map(\.title)
				== ["Skills", "Item types", "Keys and secrets", "Marketplace"])
		#expect(ProfileMenu.items(in: .admin, hasWorkspace: true).map(\.title) == ["Native surfaces", "Advanced"])
	}

	@Test func workspaceScopedRowsHideWithoutAWorkspace() {
		#expect(ProfileMenu.items(in: .account, hasWorkspace: false) == [.settings, .account, .notifications, .appLock])
		#expect(ProfileMenu.items(in: .workspace, hasWorkspace: false).isEmpty)
		#expect(ProfileMenu.items(in: .admin, hasWorkspace: false) == [.nativeSurfaces, .advanced])
	}

	@Test func settingsIsTheFirstAccountRow() {
		#expect(ProfileMenu.items(in: .account, hasWorkspace: true).first == .settings)
		#expect(ProfileMenu.items(in: .account, hasWorkspace: false).first == .settings)
	}

	@Test func everyItemIsInExactlyOneSection() {
		let all = ProfileMenuGroup.allCases.flatMap { ProfileMenu.items(in: $0, hasWorkspace: true) }
		#expect(Set(all) == Set(ProfileMenuItem.allCases))
		#expect(all.count == ProfileMenuItem.allCases.count)
	}
}

@Suite("SettingsPageRow")
struct SettingsPageRowTests {
	@Test func fiveSectionsWithOneAdvancedRow() {
		#expect(SettingsPageRow.Section.allCases.count == 5)
		#expect(SettingsPageRow.rows(in: .account, hasWorkspace: true).map(\.title) == ["Account", "Billing"])
		#expect(
			SettingsPageRow.rows(in: .preferences, hasWorkspace: true).map(\.title)
				== ["Notifications", "App lock", "Sign in a device"])
		#expect(
			SettingsPageRow.rows(in: .workspace, hasWorkspace: true).map(\.title)
				== ["Members", "Integrations", "Triggers", "Files"])
		#expect(
			SettingsPageRow.rows(in: .access, hasWorkspace: true).map(\.title)
				== ["Skills", "Item types", "Keys and secrets"])
		#expect(SettingsPageRow.rows(in: .advanced, hasWorkspace: true) == [.advanced])
	}
}

@Suite("AppearancePreference")
struct AppearancePreferenceTests {
	@Test func cyclesFollowDeviceLightDarkAndBack() {
		#expect(AppearancePreference.system.next == .light)
		#expect(AppearancePreference.light.next == .dark)
		#expect(AppearancePreference.dark.next == .system)
	}

	@Test func unknownStoredValueMeansFollowDevice() throws {
		let defaults = try #require(UserDefaults(suiteName: "appearance-test-\(UUID().uuidString)"))
		#expect(AppearancePreference.stored(in: defaults) == .system)
		defaults.set("dark", forKey: AppearancePreference.storageKey)
		#expect(AppearancePreference.stored(in: defaults) == .dark)
		defaults.set("sepia", forKey: AppearancePreference.storageKey)
		#expect(AppearancePreference.stored(in: defaults) == .system)
	}
}
