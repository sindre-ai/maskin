import Foundation

/// Row decisions for the most used settings pages: the Settings hub, Members, a member's page and
/// Integrations. They sit here, not in the views, so a unit test can state which rows show, what
/// each trailing state says and when a row is tappable. The views only draw what these return.
public enum SettingsRowRules {
	// MARK: Settings hub

	/// The App lock row: only inside the signed-in app (there is a controller), and only when the
	/// device can lock or the lock is already on, so a person can always turn it off.
	public static func showsAppLock(availability: AppLockAvailability?, isEnabled: Bool) -> Bool {
		guard let availability else { return false }
		return availability != .unavailable || isEnabled
	}

	/// Footer under the App lock switch: how it unlocks and when it locks.
	public static func appLockFooter(_ availability: AppLockAvailability, delay: AppLockDelay = .default)
		-> String
	{
		let how: String
		switch availability {
		case .biometric(let name): how = "Unlock with \(name) or your device passcode."
		case .passcodeOnly, .unavailable: how = "Unlock with your device passcode."
		}
		return "\(how) Maskin locks when you open it, and \(delay == .immediately ? "as soon as you leave it" : "after \(delay.label) in the background")."
	}

	/// The figure or word beside a hub row. Nil shows nothing: a figure appears only when it is known.
	@MainActor
	public static func hubDetail(
		for row: SettingsPageRow, accountName: String?, appLockEnabled: Bool?, counts: SettingsCountsStore?
	) -> String? {
		switch row {
		case .account: accountName
		case .billing: counts?.plan
		case .appLock: appLockEnabled.map { $0 ? "On" : "Off" }
		case .members: SettingsCountsStore.detail(counts?.members)
		case .integrations: counts?.integrationsDetail
		case .triggers: SettingsCountsStore.detail(counts?.triggers)
		case .files: SettingsCountsStore.detail(counts?.files)
		case .skills: SettingsCountsStore.detail(counts?.skills)
		case .objectTypes: SettingsCountsStore.detail(counts?.itemTypes)
		default: nil
		}
	}

	// MARK: Members

	/// A person's trailing state on the Members page: their role, or Updating while a change is out.
	public static func memberAccessory(isBusy: Bool, role: MemberRole) -> PageState {
		isBusy ? PageState("Updating", .muted) : WorkspacePageState.member(role: role)
	}

	/// A pending invitation's trailing state: Invited, or Updating while a resend or cancel is out.
	public static func invitationAccessory(isBusy: Bool) -> PageState {
		isBusy ? PageState("Updating", .muted) : PageState("Invited", .muted)
	}

	/// The Invited group shows only for people who can manage invitations, and only when one is pending.
	public static func showsInvitedGroup(canManage: Bool, pendingCount: Int) -> Bool {
		canManage && pendingCount > 0
	}

	/// The footnote under the Members rows.
	public static func membersFootnote(canAdd: Bool) -> String {
		if canAdd {
			return "Tap an agent to see what it is doing or pause it. To add someone, ask them for the ID on their profile."
		}
		return "Tap an agent to see what it is doing. Only owners and admins can add people."
	}

	/// Add someone by ID is the main button unless Invite people is on the page, which then leads.
	public static func addByIDIsPrimary(canInvite: Bool) -> Bool { !canInvite }

	// MARK: A member's page

	/// One line in the Role card of a member's page.
	public struct RoleChoice: Equatable, Sendable {
		public var id: String
		/// The role tapping the row sets.
		public var role: MemberRole
		public var title: String
		public var subtitle: String?
		/// Shows the check.
		public var isSelected: Bool
		/// Tapping it sets the role. False for the chosen role and for a role no one can change.
		public var isTappable: Bool
	}

	/// Someone who can change the role sees Admin and Member to choose from. Everyone else sees the
	/// current role alone, ticked and not tappable (an owner, yourself, an agent, or a viewer).
	public static func roleChoices(current: MemberRole, canChange: Bool) -> [RoleChoice] {
		guard canChange else {
			return [
				RoleChoice(
					id: "role", role: current, title: current.label, subtitle: nil, isSelected: true,
					isTappable: false)
			]
		}
		return [MemberRole.admin, .member].map { role in
			RoleChoice(
				id: role.rawValue, role: role, title: role.label,
				subtitle: role == .admin ? "Manages people and integrations" : "Works with items and agents",
				isSelected: role == current, isTappable: role != current)
		}
	}

	/// One line in the Access card: what the role allows. Read-only; the API has no per-person switches.
	public struct AccessLine: Equatable, Sendable {
		public var id: String
		public var title: String
		public var state: PageState
	}

	/// Every member can edit items and use agents; only owners and admins manage people.
	public static func accessLines(for role: MemberRole) -> [AccessLine] {
		[
			AccessLine(id: "edit", title: "Can edit items", state: PageState("Yes", .active)),
			AccessLine(id: "agents", title: "Can use agents", state: PageState("Yes", .active)),
			AccessLine(
				id: "manage", title: "Can manage people",
				state: role.canManage ? PageState("Yes", .active) : PageState("No", .muted)),
		]
	}

	// MARK: Integrations

	/// The line under a connected account. A connected one shows the provider's own note when it
	/// keeps one; every other state says it needs sign-in.
	public static func connectedSubtitle(
		state: ConnectedIntegration.State, note: String?, account: String?
	) -> String {
		if state == .connected, let note { return note }
		return WorkspacePageState.integrationSubtitle(state, account: account)
	}

	/// The line under a tool server: nothing while it works, the sign-in sentence otherwise.
	public static func toolServerSubtitle(state: ConnectedIntegration.State) -> String? {
		state == .connected ? nil : WorkspacePageState.integrationSubtitle(state, account: nil)
	}

	/// A connected row opens its menu for managers, and not while a connect is running.
	public static func connectedRowIsTappable(canManage: Bool, connectInFlight: Bool) -> Bool {
		canManage && !connectInFlight
	}

	/// A Discover row connects for managers when the provider can start here, and not while another
	/// connect is running.
	public static func availableRowIsTappable(
		canManage: Bool, canStartConnect: Bool, connectInFlight: Bool
	) -> Bool {
		canManage && canStartConnect && !connectInFlight
	}

	/// A button in the menu a connected row opens.
	public enum IntegrationAction: Hashable, Sendable {
		case reconnect, agentAccess, disconnect, remove
	}

	/// The menu of a connected row, in order. A tool server only offers Remove. Reconnect shows for
	/// managers when the account is not connected and can be started here. Agent access needs the
	/// page services and a connected account. Everything else ends with Disconnect.
	public static func integrationActions(
		isToolServer: Bool, canManage: Bool, canStartConnect: Bool, state: ConnectedIntegration.State,
		hasServices: Bool
	) -> [IntegrationAction] {
		var actions: [IntegrationAction] = []
		if !isToolServer, canManage, canStartConnect, state != .connected { actions.append(.reconnect) }
		if hasServices, state == .connected { actions.append(.agentAccess) }
		actions.append(isToolServer ? .remove : .disconnect)
		return actions
	}

	/// The empty line on the Connected tab, or nil when there are rows. While searching, an empty
	/// list says nothing matches; otherwise it follows the load.
	public static func connectedEmptyText(
		hasRows: Bool, isSearching: Bool, phase: IntegrationsStore.Phase
	) -> String? {
		if hasRows { return nil }
		if isSearching { return "No integration matches that search." }
		switch phase {
		case .failed(let message): return message
		case .loaded: return "Nothing connected yet."
		case .idle, .loading: return "Loading integrations"
		}
	}

	/// The empty line on the Discover tab, or nil when there are rows.
	public static func discoverEmptyText(hasRows: Bool, isSearching: Bool) -> String? {
		if hasRows { return nil }
		return isSearching ? "No integration matches that search." : "Nothing to discover."
	}

	/// The Drive folder watches card: for a connected Drive, when not searching, under All or Files.
	public static func showsDriveWatches(
		hasServices: Bool, hasConnectedDrive: Bool, isSearching: Bool, category: IntegrationCategory?
	) -> Bool {
		hasServices && hasConnectedDrive && !isSearching && (category == nil || category == .files)
	}

	/// The Add your own MCP server and Import from Claude card: not while searching, and only under
	/// All or Custom.
	public static func showsAddCard(isSearching: Bool, category: IntegrationCategory?) -> Bool {
		!isSearching && (category == nil || category == .custom)
	}

	/// A row on the add card.
	public enum AddRow: Equatable, Sendable {
		case toolServer, importFromClaude
	}

	/// Adding a tool server is for managers; both rows need the page services (previews have none).
	public static func addRows(canManage: Bool, hasServices: Bool) -> [AddRow] {
		var rows: [AddRow] = []
		if canManage, hasServices { rows.append(.toolServer) }
		if hasServices { rows.append(.importFromClaude) }
		return rows
	}

	/// The footnote under the Integrations page.
	public static func integrationsFootnote(canManage: Bool) -> String {
		canManage
			? "Connecting signs you in with the provider. When you come back, this list refreshes."
			: "Only owners and admins can connect or disconnect an integration."
	}
}
