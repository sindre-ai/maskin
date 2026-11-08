import Foundation

/// The section headers of the account menu, in order. The menu is one scrolling list; Appearance
/// and Sign out follow the last section and are not rows of this model. Settings is the first row of
/// Account: it is the only way into the Settings page (Files, the analytics switch).
public enum ProfileMenuGroup: String, CaseIterable, Hashable, Identifiable, Sendable {
	case account, workspace, access, admin

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .account: "Account"
		case .workspace: "Workspace"
		case .access: "Agents and access"
		case .admin: "Admin"
		}
	}
}

public enum ProfileMenuItem: String, CaseIterable, Hashable, Identifiable, Sendable {
	case settings, account, billing, notifications, appLock, deviceSignIn
	case agents, members, integrations, triggers
	case skills, objectTypes, keys, marketplace
	case nativeSurfaces, advanced

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .settings: "Settings"
		case .account: "Account"
		case .billing: "Billing"
		case .notifications: "Notifications"
		case .appLock: "App lock"
		case .deviceSignIn: "Sign in a device"
		case .agents: "Agents"
		case .members: "Members"
		case .integrations: "Integrations"
		case .triggers: "Triggers"
		case .skills: "Skills"
		case .objectTypes: "Item types"
		case .keys: "Keys and secrets"
		case .marketplace: "Marketplace"
		case .nativeSurfaces: "Native surfaces"
		case .advanced: "Advanced"
		}
	}

	public var group: ProfileMenuGroup {
		switch self {
		case .settings, .account, .billing, .notifications, .appLock, .deviceSignIn: .account
		case .agents, .members, .integrations, .triggers: .workspace
		case .skills, .objectTypes, .keys, .marketplace: .access
		case .nativeSurfaces, .advanced: .admin
		}
	}

	/// These belong to a workspace; without one there is nothing to open.
	var needsWorkspace: Bool {
		switch self {
		case .billing, .deviceSignIn, .agents, .members, .integrations, .triggers, .skills, .objectTypes, .keys,
			.marketplace:
			true
		case .settings, .account, .notifications, .appLock, .nativeSurfaces, .advanced: false
		}
	}
}

public enum ProfileMenu {
	/// The rows of one section, in order.
	public static func items(in group: ProfileMenuGroup, hasWorkspace: Bool) -> [ProfileMenuItem] {
		ProfileMenuItem.allCases.filter { $0.group == group && (hasWorkspace || !$0.needsWorkspace) }
	}
}

/// What the Settings page lists, in five sections. Marketplace, Agents and Native surfaces live in
/// the account menu only; Files lives here only.
public enum SettingsPageRow: String, CaseIterable, Hashable, Sendable {
	case account, billing
	case notifications, appLock, deviceSignIn
	case members, integrations, triggers, files
	case skills, objectTypes, keys
	case advanced

	public enum Section: String, CaseIterable, Hashable, Identifiable, Sendable {
		case account, preferences, workspace, access, advanced

		public var id: String { rawValue }

		/// The advanced section is one row with no header.
		public var title: String? {
			switch self {
			case .account: "Account"
			case .preferences: "Preferences"
			case .workspace: "Workspace"
			case .access: "Agents and access"
			case .advanced: nil
			}
		}
	}

	public var section: Section {
		switch self {
		case .account, .billing: .account
		case .notifications, .appLock, .deviceSignIn: .preferences
		case .members, .integrations, .triggers, .files: .workspace
		case .skills, .objectTypes, .keys: .access
		case .advanced: .advanced
		}
	}

	public var title: String {
		switch self {
		case .account: "Account"
		case .billing: "Billing"
		case .notifications: "Notifications"
		case .appLock: "App lock"
		case .deviceSignIn: "Sign in a device"
		case .members: "Members"
		case .integrations: "Integrations"
		case .triggers: "Triggers"
		case .files: "Files"
		case .skills: "Skills"
		case .objectTypes: "Item types"
		case .keys: "Keys and secrets"
		case .advanced: "Advanced"
		}
	}

	var needsWorkspace: Bool {
		switch self {
		case .account, .notifications, .appLock, .advanced: false
		default: true
		}
	}

	public static func rows(in section: Section, hasWorkspace: Bool) -> [SettingsPageRow] {
		allCases.filter { $0.section == section && (hasWorkspace || !$0.needsWorkspace) }
	}
}
