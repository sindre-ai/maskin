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
	case agents, marketplace, artefacts, settings, triggers

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .agents: "Agents"
		case .marketplace: "Marketplace"
		case .artefacts: "Artefacts"
		case .settings: "Settings"
		case .triggers: "Triggers"
		}
	}

	public var group: ProfileMenuGroup {
		switch self {
		case .agents, .marketplace, .artefacts: .workspace
		case .settings, .triggers: .you
		}
	}

	/// Marketplace and Triggers belong to a workspace; without one there is nothing to open.
	var needsWorkspace: Bool { self == .marketplace || self == .triggers }
}

public enum ProfileMenu {
	/// The rows of one group, in order. Autonomy has no API yet, so it has no row.
	public static func items(in group: ProfileMenuGroup, hasWorkspace: Bool) -> [ProfileMenuItem] {
		ProfileMenuItem.allCases.filter { $0.group == group && (hasWorkspace || !$0.needsWorkspace) }
	}
}
