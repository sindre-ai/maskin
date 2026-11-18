import Foundation
import Testing

@testable import MaskinCore

@Suite("SettingsRowRules: hub")
struct SettingsHubRulesTests {
	@Test("App lock shows only where the device can lock, or when it is already on")
	func appLockRow() {
		#expect(!SettingsRowRules.showsAppLock(availability: nil, isEnabled: true))
		#expect(SettingsRowRules.showsAppLock(availability: .biometric(name: "Face ID"), isEnabled: false))
		#expect(SettingsRowRules.showsAppLock(availability: .passcodeOnly, isEnabled: false))
		#expect(!SettingsRowRules.showsAppLock(availability: .unavailable, isEnabled: false))
		#expect(SettingsRowRules.showsAppLock(availability: .unavailable, isEnabled: true))
	}

	@Test("the App lock footer names the unlock method and when it locks")
	func appLockFooter() {
		#expect(
			SettingsRowRules.appLockFooter(.biometric(name: "Face ID"), delay: .oneMinute)
				== "Unlock with Face ID or your device passcode. Maskin locks when you open it, and after 1 minute in the background."
		)
		#expect(
			SettingsRowRules.appLockFooter(.passcodeOnly, delay: .immediately)
				== "Unlock with your device passcode. Maskin locks when you open it, and as soon as you leave it.")
		#expect(
			SettingsRowRules.appLockFooter(.unavailable)
				== "Unlock with your device passcode. Maskin locks when you open it, and after 30 seconds in the background."
		)
	}

	@MainActor
	@Test("a hub row shows a figure only when it is known")
	func hubDetails() async {
		let fake = FakeSettings()
		fake.members = [
			WorkspaceMember(actorId: "h-1", name: "Sam", isAgent: false, role: .owner),
			WorkspaceMember(actorId: "h-2", name: "Kai", isAgent: false, role: .member),
		]
		let counts = SettingsCountsStore(
			workspaceId: "ws", members: fake, integrations: fake, skills: fake, schema: fake, billing: fake,
			triggerCount: { 0 }, fileCount: { _ in 2 })

		// Before anything loads, no row has a figure.
		#expect(SettingsRowRules.hubDetail(for: .members, accountName: nil, appLockEnabled: nil, counts: counts) == nil)
		#expect(SettingsRowRules.hubDetail(for: .billing, accountName: nil, appLockEnabled: nil, counts: nil) == nil)

		await counts.load()
		func detail(_ row: SettingsPageRow) -> String? {
			SettingsRowRules.hubDetail(for: row, accountName: "Sam", appLockEnabled: true, counts: counts)
		}
		#expect(detail(.members) == "2")
		#expect(detail(.files) == "2")
		#expect(detail(.billing) == "Pro")
		// Zero hides the figure, and so does no integration being connected.
		#expect(detail(.triggers) == nil)
		#expect(detail(.integrations) == nil)
		// The account row names the person; App lock says On or Off, or nothing outside the app.
		#expect(detail(.account) == "Sam")
		#expect(detail(.appLock) == "On")
		#expect(
			SettingsRowRules.hubDetail(for: .appLock, accountName: nil, appLockEnabled: false, counts: counts) == "Off")
		#expect(
			SettingsRowRules.hubDetail(for: .appLock, accountName: nil, appLockEnabled: nil, counts: counts) == nil)
		// Rows with no figure never get one.
		#expect(detail(.notifications) == nil)
		#expect(detail(.advanced) == nil)
	}
}

@Suite("SettingsRowRules: members")
struct SettingsMembersRulesTests {
	@Test("a person's trailing state is their role, or Updating while a change is out")
	func memberAccessory() {
		#expect(SettingsRowRules.memberAccessory(isBusy: false, role: .admin) == PageState("Admin", .plain))
		#expect(SettingsRowRules.memberAccessory(isBusy: true, role: .admin) == PageState("Updating", .muted))
	}

	@Test("an invitation says Invited, or Updating while a resend or cancel is out")
	func invitationAccessory() {
		#expect(SettingsRowRules.invitationAccessory(isBusy: false) == PageState("Invited", .muted))
		#expect(SettingsRowRules.invitationAccessory(isBusy: true) == PageState("Updating", .muted))
	}

	@Test("the Invited group needs a manager and at least one pending invitation")
	func invitedGroup() {
		#expect(SettingsRowRules.showsInvitedGroup(canManage: true, pendingCount: 1))
		#expect(!SettingsRowRules.showsInvitedGroup(canManage: true, pendingCount: 0))
		#expect(!SettingsRowRules.showsInvitedGroup(canManage: false, pendingCount: 3))
	}

	@Test("the footnote tells a manager how to add someone and everyone else who can")
	func footnote() {
		#expect(SettingsRowRules.membersFootnote(canAdd: true).contains("ask them for the ID"))
		#expect(
			SettingsRowRules.membersFootnote(canAdd: false)
				== "Tap an agent to see what it is doing. Only owners and admins can add people.")
	}

	@Test("Add someone by ID leads only when Invite people is not on the page")
	func addByIDEmphasis() {
		#expect(SettingsRowRules.addByIDIsPrimary(canInvite: false))
		#expect(!SettingsRowRules.addByIDIsPrimary(canInvite: true))
	}
}

@Suite("SettingsRowRules: a member's page")
struct SettingsMemberPageRulesTests {
	@Test("someone who can change the role chooses between Admin and Member, and the current one is not tappable")
	func choosableRoles() {
		let choices = SettingsRowRules.roleChoices(current: .member, canChange: true)
		#expect(choices.map(\.title) == ["Admin", "Member"])
		#expect(choices.map(\.role) == [.admin, .member])
		#expect(choices.map(\.isSelected) == [false, true])
		#expect(choices.map(\.isTappable) == [true, false])
		#expect(choices[0].subtitle == "Manages people and integrations")
		#expect(choices[1].subtitle == "Works with items and agents")

		let admin = SettingsRowRules.roleChoices(current: .admin, canChange: true)
		#expect(admin.map(\.isSelected) == [true, false])
		#expect(admin.map(\.isTappable) == [false, true])
	}

	@Test("when the role cannot change, the current role shows alone, ticked and not tappable")
	func fixedRole() {
		for role in MemberRole.allCases {
			let choices = SettingsRowRules.roleChoices(current: role, canChange: false)
			#expect(choices.count == 1)
			#expect(choices.first?.title == role.label)
			#expect(choices.first?.role == role)
			#expect(choices.first?.isSelected == true)
			#expect(choices.first?.isTappable == false)
		}
	}

	@Test("an owner is never offered as a role to choose")
	func ownerNotOffered() {
		let choices = SettingsRowRules.roleChoices(current: .owner, canChange: true)
		#expect(!choices.map(\.role).contains(.owner))
	}

	@Test("every role can edit and use agents, only owners and admins manage people")
	func accessLines() {
		for role in MemberRole.allCases {
			let lines = SettingsRowRules.accessLines(for: role)
			#expect(lines.map(\.title) == ["Can edit items", "Can use agents", "Can manage people"])
			#expect(lines[0].state == PageState("Yes", .active))
			#expect(lines[1].state == PageState("Yes", .active))
			#expect(
				lines[2].state == (role.canManage ? PageState("Yes", .active) : PageState("No", .muted)))
		}
	}
}

@Suite("SettingsRowRules: integrations")
struct SettingsIntegrationsRulesTests {
	@Test("a connected account shows the provider's note, every other state says it needs sign-in")
	func connectedSubtitle() {
		#expect(
			SettingsRowRules.connectedSubtitle(state: .connected, note: "Covers mail", account: "me@x.com")
				== "Covers mail")
		#expect(
			SettingsRowRules.connectedSubtitle(state: .connected, note: nil, account: "me@x.com")
				== "Connected as me@x.com")
		#expect(SettingsRowRules.connectedSubtitle(state: .connected, note: nil, account: nil) == "Connected")
		// A note never hides that the account needs signing in again.
		#expect(
			SettingsRowRules.connectedSubtitle(
				state: .needsReconnect(missingScopes: 1), note: "Covers mail", account: "me@x.com")
				== "Needs sign-in")
		#expect(
			SettingsRowRules.connectedSubtitle(state: .incomplete, note: nil, account: nil) == "Needs sign-in")
		#expect(
			SettingsRowRules.connectedSubtitle(state: .disconnected, note: "Covers mail", account: nil)
				== "Needs sign-in")
	}

	@Test("a tool server says nothing while it works")
	func toolServerSubtitle() {
		#expect(SettingsRowRules.toolServerSubtitle(state: .connected) == nil)
		#expect(SettingsRowRules.toolServerSubtitle(state: .disconnected) == "Needs sign-in")
		#expect(SettingsRowRules.toolServerSubtitle(state: .needsReconnect(missingScopes: 2)) == "Needs sign-in")
	}

	@Test("rows open only for managers, and not while a connect is running")
	func tappableRows() {
		#expect(SettingsRowRules.connectedRowIsTappable(canManage: true, connectInFlight: false))
		#expect(!SettingsRowRules.connectedRowIsTappable(canManage: true, connectInFlight: true))
		#expect(!SettingsRowRules.connectedRowIsTappable(canManage: false, connectInFlight: false))

		#expect(
			SettingsRowRules.availableRowIsTappable(canManage: true, canStartConnect: true, connectInFlight: false))
		#expect(
			!SettingsRowRules.availableRowIsTappable(canManage: true, canStartConnect: false, connectInFlight: false)
		)
		#expect(
			!SettingsRowRules.availableRowIsTappable(canManage: true, canStartConnect: true, connectInFlight: true))
		#expect(
			!SettingsRowRules.availableRowIsTappable(canManage: false, canStartConnect: true, connectInFlight: false)
		)
	}

	private func actions(
		_ state: ConnectedIntegration.State, toolServer: Bool = false, canManage: Bool = true,
		canStart: Bool = true, services: Bool = true
	) -> [SettingsRowRules.IntegrationAction] {
		SettingsRowRules.integrationActions(
			isToolServer: toolServer, canManage: canManage, canStartConnect: canStart, state: state,
			hasServices: services)
	}

	@Test("a connected account offers Agent access and Disconnect")
	func connectedMenu() {
		#expect(actions(.connected) == [.agentAccess, .disconnect])
		// No page services (a preview) means no Agent access.
		#expect(actions(.connected, services: false) == [.disconnect])
	}

	@Test("an account that needs sign-in offers Reconnect first, for managers who can start it here")
	func reconnectMenu() {
		#expect(actions(.needsReconnect(missingScopes: 1)) == [.reconnect, .disconnect])
		#expect(actions(.disconnected) == [.reconnect, .disconnect])
		#expect(actions(.incomplete) == [.reconnect, .disconnect])
		#expect(actions(.disconnected, canManage: false) == [.disconnect])
		#expect(actions(.disconnected, canStart: false) == [.disconnect])
	}

	@Test("a tool server offers Remove and nothing to reconnect")
	func toolServerMenu() {
		#expect(actions(.connected, toolServer: true) == [.agentAccess, .remove])
		#expect(actions(.disconnected, toolServer: true) == [.remove])
	}

	@Test("the Connected tab says why it is empty, and nothing when there are rows")
	func connectedEmpty() {
		#expect(SettingsRowRules.connectedEmptyText(hasRows: true, isSearching: false, phase: .loaded) == nil)
		#expect(SettingsRowRules.connectedEmptyText(hasRows: true, isSearching: true, phase: .loaded) == nil)
		#expect(
			SettingsRowRules.connectedEmptyText(hasRows: false, isSearching: false, phase: .loaded)
				== "Nothing connected yet.")
		#expect(
			SettingsRowRules.connectedEmptyText(hasRows: false, isSearching: false, phase: .loading)
				== "Loading integrations")
		#expect(
			SettingsRowRules.connectedEmptyText(hasRows: false, isSearching: false, phase: .idle)
				== "Loading integrations")
		#expect(
			SettingsRowRules.connectedEmptyText(hasRows: false, isSearching: false, phase: .failed("Offline"))
				== "Offline")
		// A search that finds nothing is a search result, whatever the load did.
		#expect(
			SettingsRowRules.connectedEmptyText(hasRows: false, isSearching: true, phase: .failed("Offline"))
				== "No integration matches that search.")
	}

	@Test("the Discover tab says why it is empty")
	func discoverEmpty() {
		#expect(SettingsRowRules.discoverEmptyText(hasRows: true, isSearching: false) == nil)
		#expect(SettingsRowRules.discoverEmptyText(hasRows: false, isSearching: false) == "Nothing to discover.")
		#expect(
			SettingsRowRules.discoverEmptyText(hasRows: false, isSearching: true)
				== "No integration matches that search.")
	}

	@Test("Drive watches show for a connected Drive under All or Files, and not while searching")
	func driveWatches() {
		func shows(
			services: Bool = true, drive: Bool = true, searching: Bool = false, category: IntegrationCategory? = nil
		) -> Bool {
			SettingsRowRules.showsDriveWatches(
				hasServices: services, hasConnectedDrive: drive, isSearching: searching, category: category)
		}
		#expect(shows())
		#expect(shows(category: .files))
		#expect(!shows(category: .code))
		#expect(!shows(searching: true))
		#expect(!shows(drive: false))
		#expect(!shows(services: false))
	}

	@Test("the add card shows under All or Custom, and not while searching")
	func addCard() {
		#expect(SettingsRowRules.showsAddCard(isSearching: false, category: nil))
		#expect(SettingsRowRules.showsAddCard(isSearching: false, category: .custom))
		#expect(!SettingsRowRules.showsAddCard(isSearching: false, category: .code))
		#expect(!SettingsRowRules.showsAddCard(isSearching: true, category: nil))
	}

	@Test("only managers add a tool server, and a preview with no services has neither row")
	func addRows() {
		#expect(SettingsRowRules.addRows(canManage: true, hasServices: true) == [.toolServer, .importFromClaude])
		#expect(SettingsRowRules.addRows(canManage: false, hasServices: true) == [.importFromClaude])
		#expect(SettingsRowRules.addRows(canManage: true, hasServices: false).isEmpty)
		#expect(SettingsRowRules.addRows(canManage: false, hasServices: false).isEmpty)
	}

	@Test("the footnote tells a manager how connecting works and everyone else who can")
	func footnote() {
		#expect(SettingsRowRules.integrationsFootnote(canManage: true).hasPrefix("Connecting signs you in"))
		#expect(
			SettingsRowRules.integrationsFootnote(canManage: false)
				== "Only owners and admins can connect or disconnect an integration.")
	}
}
