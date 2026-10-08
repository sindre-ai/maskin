import Foundation

/// The rows of the profile sheet below the profile and workspace cards, in two groups.
public enum ProfileMenuGroup: String, CaseIterable, Hashable, Identifiable, Sendable {
	case workspace, you

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .workspace: "Workspace"
		case .you: "You"
		}
	}
}

public enum ProfileMenuItem: String, CaseIterable, Hashable, Identifiable, Sendable {
	case agents, marketplace, artefacts, members, integrations, triggers, billing, keys
	case settings

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .agents: "Agents"
		case .marketplace: "Marketplace"
		case .artefacts: "Artefacts"
		case .members: "Members"
		case .integrations: "Integrations"
		case .triggers: "Triggers"
		case .billing: "Billing"
		case .keys: "Keys"
		case .settings: "Settings"
		}
	}

	/// The one-line description under the title, from the prototype.
	public var subtitle: String {
		switch self {
		case .agents: "Who works for you, and what they're doing"
		case .marketplace: "Hire an agent or install a flow"
		case .artefacts: "Pages, PDFs and files your agents made"
		case .members: "People and agents with access"
		case .integrations: "Accounts your flows can use"
		case .triggers: "What starts a flow on its own"
		case .billing: "Plan, seats, invoices"
		case .keys: "API keys for outside tools"
		case .settings: "Appearance, workspace, account"
		}
	}

	public var group: ProfileMenuGroup {
		switch self {
		case .agents, .marketplace, .artefacts, .members, .integrations, .triggers, .billing, .keys:
			.workspace
		case .settings: .you
		}
	}

	/// These belong to a workspace; without one there is nothing to open.
	var needsWorkspace: Bool {
		switch self {
		case .marketplace, .members, .integrations, .triggers, .billing, .keys: true
		default: false
		}
	}

	/// Keys are for owners and admins; everyone else never sees the row.
	var needsManager: Bool { self == .keys }
}

public enum ProfileMenu {
	/// The rows of one group, in order. Autonomy has no API yet, so it has no row.
	public static func items(
		in group: ProfileMenuGroup, hasWorkspace: Bool, role: MemberRole = .member
	) -> [ProfileMenuItem] {
		ProfileMenuItem.allCases.filter {
			$0.group == group && (hasWorkspace || !$0.needsWorkspace)
				&& (role.canManage || !$0.needsManager)
		}
	}
}
