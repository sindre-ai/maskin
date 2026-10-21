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
		#expect(ShellTab.forYou.barItems == [.live, .avatar])
		#expect(ShellTab.chats.barItems == [.display, .new, .avatar])
		#expect(ShellTab.loops.barItems == [.display, .avatar])
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
			ProfileMenu.items(in: .workspace, hasWorkspace: true, role: .owner).map(\.title)
				== [
					"Marketplace", "Artefacts", "Members", "Integrations", "Triggers",
					"Billing", "Keys & MCP",
				])
		#expect(
			ProfileMenu.items(in: .you, hasWorkspace: true).map(\.title)
				== ["Settings", "Notifications", "Autonomy"])
	}

	@Test func workspaceScopedRowsHideWithoutAWorkspace() {
		#expect(
			ProfileMenu.items(in: .workspace, hasWorkspace: false, role: .owner) == [.artefacts])
		#expect(ProfileMenu.items(in: .you, hasWorkspace: false) == [.settings, .notifications])
	}

	@Test func keysAndMCPAreForEveryMember() {
		// The page shows the person's own key and how to connect their own tools, so a plain member
		// must reach it too; what only a manager may do is gated on the page.
		for role in MemberRole.allCases {
			#expect(ProfileMenu.items(in: .workspace, hasWorkspace: true, role: role).contains(.keys))
		}
	}

	@Test func agentsLiveInsideMembersNotAsARow() {
		#expect(!ProfileMenuItem.allCases.map(\.title).contains("Agents"))
		#expect(ProfileMenuItem.members.subtitle == "People and agents in this workspace")
	}

	@Test func everyItemIsInExactlyOneGroup() {
		let all = ProfileMenuGroup.allCases.flatMap {
			ProfileMenu.items(in: $0, hasWorkspace: true, role: .owner)
		}
		#expect(Set(all) == Set(ProfileMenuItem.allCases))
		#expect(all.count == ProfileMenuItem.allCases.count)
	}

	@Test func autonomyIsPerWorkspace() {
		#expect(ProfileMenuItem.autonomy.group == .you)
		#expect(!ProfileMenu.items(in: .you, hasWorkspace: false).contains(.autonomy))
	}
}
