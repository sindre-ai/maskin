import Testing

@testable import MaskinCore

@Suite("ShellTab")
struct ShellTabTests {
	@Test func fourTabsThenSearchInOrder() {
		#expect(ShellTab.allCases == [.forYou, .chats, .loops, .objects, .search])
		#expect(ShellTab.primary == [.forYou, .chats, .loops, .objects])
	}

	@Test func titlesUseTeamAndFlows() {
		#expect(ShellTab.allCases.map(\.title) == ["For you", "Team", "Flows", "Objects", "Search"])
	}

	@Test func barItemsPerTab() {
		#expect(ShellTab.forYou.barItems == [.live, .display, .avatar])
		#expect(ShellTab.chats.barItems == [.new, .display, .avatar])
		#expect(ShellTab.loops.barItems == [.avatar])
		#expect(ShellTab.objects.barItems == [.display, .avatar])
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
	@Test func workspaceGroupThenYouGroup() {
		#expect(
			ProfileMenu.items(in: .workspace, hasWorkspace: true).map(\.title)
				== ["Agents", "Marketplace", "Artefacts"])
		#expect(
			ProfileMenu.items(in: .you, hasWorkspace: true).map(\.title)
				== ["Settings", "Triggers"])
	}

	@Test func workspaceScopedRowsHideWithoutAWorkspace() {
		#expect(ProfileMenu.items(in: .workspace, hasWorkspace: false) == [.agents, .artefacts])
		#expect(ProfileMenu.items(in: .you, hasWorkspace: false) == [.settings])
	}

	@Test func everyItemIsInExactlyOneGroup() {
		let all = ProfileMenuGroup.allCases.flatMap { ProfileMenu.items(in: $0, hasWorkspace: true) }
		#expect(Set(all) == Set(ProfileMenuItem.allCases))
		#expect(all.count == ProfileMenuItem.allCases.count)
	}
}
