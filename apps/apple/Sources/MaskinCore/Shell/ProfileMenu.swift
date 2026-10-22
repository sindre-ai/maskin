import Foundation

/// The rows of the profile sheet below the profile and workspace cards, in two groups. There is
/// no Agents row: agents live inside Members (handoff `7-Chat.md` §10).
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
	case marketplace, artefacts, members, integrations, triggers, billing, keys
	case settings, autonomy

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .marketplace: "Marketplace"
		case .artefacts: "Artefacts"
		case .members: "Members"
		case .integrations: "Integrations"
		case .triggers: "Triggers"
		case .billing: "Billing"
		case .keys: "Keys & MCP"
		case .settings: "Settings"
		case .autonomy: "Autonomy"
		}
	}

	/// The one-line description under the title, from the prototype.
	public var subtitle: String {
		switch self {
		case .marketplace: "Hire an agent or install a flow"
		case .artefacts: "Pages, PDFs and files your agents made"
		case .members: "People and agents in this workspace"
		case .integrations: "Accounts your flows can use"
		case .triggers: "What starts a flow on its own"
		case .billing: "Plan, seats, invoices"
		case .keys: "API keys and the MCP server for outside tools"
		case .settings: "Appearance, notifications, workspace, account"
		case .autonomy: "How far the Chief of Staff goes before asking"
		}
	}

	public var group: ProfileMenuGroup {
		switch self {
		case .marketplace, .artefacts, .members, .integrations, .triggers, .billing, .keys:
			.workspace
		case .settings, .autonomy: .you
		}
	}

	/// These belong to a workspace; without one there is nothing to open.
	var needsWorkspace: Bool {
		switch self {
		case .marketplace, .members, .integrations, .triggers, .billing, .keys, .autonomy: true
		default: false
		}
	}

	/// Rows only a manager may see. Keys & MCP is for everyone: the page shows the person's own key
	/// and how to connect their own tools; what a manager can additionally do is gated on the page.
	var needsManager: Bool { false }
}

public enum ProfileMenu {
	/// The rows of one group, in order.
	public static func items(
		in group: ProfileMenuGroup, hasWorkspace: Bool, role: MemberRole = .member
	) -> [ProfileMenuItem] {
		ProfileMenuItem.allCases.filter {
			$0.group == group && (hasWorkspace || !$0.needsWorkspace)
				&& (role.canManage || !$0.needsManager)
		}
	}
}
