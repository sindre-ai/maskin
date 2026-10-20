import Foundation

/// A failure with a sentence a person can read. Carries no ids, tokens or response bodies.
public struct SettingsError: Error, Equatable, Sendable {
	public var message: String
	/// The request never reached the server (no connection), so retrying later can work.
	public var isOffline = false
	public init(_ message: String) { self.message = message }

	public static let offline = SettingsError("You're offline.", isOffline: true)
	private init(_ message: String, isOffline: Bool) {
		self.message = message
		self.isOffline = isOffline
	}

	/// The server has no MCP client or tool listing yet (see `MCPAPI`).
	public static let mcpNotAvailable = SettingsError("Not available on this server yet.")
}

/// A secret that never prints itself. `description`, `debugDescription`, `dump` and string
/// interpolation all yield a mask; the value is only reachable through `reveal()`, which the UI
/// calls on an explicit tap (show, copy).
public struct SecretValue: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible,
	CustomReflectable
{
	private let value: String
	public init(_ value: String) { self.value = value }

	/// The raw secret. Call only from an explicit user action.
	public func reveal() -> String { value }

	/// `ank_…ab12`: enough to recognise a key without exposing it.
	public var masked: String {
		guard value.count > 8 else { return String(repeating: "•", count: 12) }
		return "\(value.prefix(4))••••••••\(value.suffix(4))"
	}

	public var description: String { "SecretValue(redacted)" }
	public var debugDescription: String { "SecretValue(redacted)" }
	public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

/// A role in a workspace. `owner` is read-only here: ownership moves through a separate server
/// flow, and the member-role API only accepts `admin` / `member`.
public enum MemberRole: String, Sendable, Equatable, CaseIterable {
	case owner, admin, member

	public init(serverValue: String) { self = MemberRole(rawValue: serverValue) ?? .member }

	public var label: String {
		switch self {
		case .owner: "Owner"
		case .admin: "Admin"
		case .member: "Member"
		}
	}

	/// Owners and admins manage members and integrations.
	public var canManage: Bool { self == .owner || self == .admin }
}

public struct WorkspaceMember: Identifiable, Sendable, Equatable {
	public var id: String { actorId }
	public var actorId: String
	public var name: String
	public var isAgent: Bool
	public var role: MemberRole
	public var joinedAt: Date?

	public init(actorId: String, name: String, isAgent: Bool, role: MemberRole, joinedAt: Date? = nil) {
		self.actorId = actorId
		self.name = name
		self.isAgent = isAgent
		self.role = role
		self.joinedAt = joinedAt
	}
}

public struct ProfileInfo: Sendable, Equatable {
	public var actorId: String
	public var name: String
	public var email: String?
	public init(actorId: String, name: String, email: String?) {
		self.actorId = actorId
		self.name = name
		self.email = email
	}
}

public struct IntegrationProvider: Identifiable, Sendable, Equatable {
	public enum AuthKind: Sendable, Equatable { case oauth, apiKey, manual }
	/// Provider slug, used for the request path only; never shown.
	public var id: String
	public var displayName: String
	public var authKind: AuthKind
	/// Whether the connected account's email is the right secondary label.
	public var showsEmail: Bool
	public var eventCount: Int

	public init(
		id: String, displayName: String, authKind: AuthKind, showsEmail: Bool = false,
		eventCount: Int = 0
	) {
		self.id = id
		self.displayName = displayName
		self.authKind = authKind
		self.showsEmail = showsEmail
		self.eventCount = eventCount
	}
}

public struct ConnectedIntegration: Identifiable, Sendable, Equatable {
	public enum State: Sendable, Equatable {
		/// Credentials are live.
		case connected
		/// Live, but its token predates scopes the provider now needs.
		case needsReconnect(missingScopes: Int)
		/// Started but not finished (waiting on a secret or a callback).
		case incomplete
		/// Revoked, errored or restored without credentials: connect again.
		case disconnected
	}

	public var id: String
	/// Provider slug; resolved to a display name through `IntegrationProvider`, never shown.
	public var provider: String
	public var state: State
	/// The provider's identifier for the connected account. It is an email for some providers
	/// (`IntegrationProvider.showsEmail`) and an opaque id for the rest, so views must go through
	/// `IntegrationsStore.accountLabel(for:)` and never print it directly.
	public var externalId: String?

	public init(id: String, provider: String, state: State, externalId: String? = nil) {
		self.id = id
		self.provider = provider
		self.state = state
		self.externalId = externalId
	}

	public init(
		id: String, provider: String, status: String, externalId: String?, missingScopes: Int,
		needsReconnect: Bool
	) {
		let state: State
		switch status {
		case "active": state = needsReconnect ? .needsReconnect(missingScopes: missingScopes) : .connected
		case "pending", "awaiting_secret": state = .incomplete
		default: state = .disconnected
		}
		self.init(id: id, provider: provider, state: state, externalId: externalId)
	}
}

/// One row of the AGENTS group in Members. Agents come from `AgentsStore` (so their live status
/// is known); a workspace member of type agent that the agents list has not resolved yet is
/// still listed, with no status.
public struct MemberAgentRow: Identifiable, Sendable, Equatable {
	public var id: String
	public var name: String
	public var role: String
	public var status: AgentStatus?

	public init(id: String, name: String, role: String, status: AgentStatus?) {
		self.id = id
		self.name = name
		self.role = role
		self.status = status
	}

	/// "Working" / "Idle" / "Paused" / "Failed"; nil while the status is unknown.
	public var statusLabel: String? { status?.label }
	/// Only a working agent is a signal; everything else is quiet grey.
	public var isWorking: Bool { status == .running }
}

/// Members = people from the workspace member list + agents from `AgentsStore`, in two groups.
/// Pure, so the merge is testable without either store.
public enum MembersRoster {
	public struct Groups: Sendable, Equatable {
		public var people: [WorkspaceMember]
		public var agents: [MemberAgentRow]
		public init(people: [WorkspaceMember], agents: [MemberAgentRow]) {
			self.people = people
			self.agents = agents
		}
	}

	/// People keep the member order (owner, admins, members). Agents are the agents list, working
	/// first, then paused, idle and failed, alphabetical within a state; a member of type agent
	/// missing from the agents list is appended with an unknown status, so nobody disappears while
	/// the agents list is still loading.
	public static func groups(members: [WorkspaceMember], agents: [AgentSummary]) -> Groups {
		let people = members.filter { !$0.isAgent }
		var rows = agents.map {
			MemberAgentRow(id: $0.id, name: $0.name, role: $0.role, status: $0.status)
		}
		let known = Set(rows.map(\.id))
		for member in members where member.isAgent && !known.contains(member.id) {
			rows.append(MemberAgentRow(id: member.id, name: member.name, role: "Agent", status: nil))
		}
		rows.sort { a, b in
			let ra = rank(a.status), rb = rank(b.status)
			if ra != rb { return ra < rb }
			return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
		}
		return Groups(people: people, agents: rows)
	}

	private static func rank(_ status: AgentStatus?) -> Int {
		switch status {
		case .running: 0
		case .paused: 1
		case .idle: 2
		case .failed: 3
		case nil: 4
		}
	}
}

/// A tool connected to the workspace's MCP server (Claude Desktop, Cursor, …).
public struct MCPClient: Identifiable, Sendable, Equatable {
	public enum Access: Sendable, Equatable {
		case readWrite, readOnly
		public var label: String {
			switch self {
			case .readWrite: "Read + write"
			case .readOnly: "Read only"
			}
		}
	}

	public var id: String
	public var name: String
	public var access: Access
	public var lastCallAt: Date?

	public init(id: String, name: String, access: Access, lastCallAt: Date? = nil) {
		self.id = id
		self.name = name
		self.access = access
		self.lastCallAt = lastCallAt
	}
}

/// What the MCP server exposes and how a client may sign in.
public struct MCPServerInfo: Sendable, Equatable {
	/// Number of tools the server lists; nil when the server does not say.
	public var toolCount: Int?
	/// Clients can sign in with OAuth. A bearer API key always works.
	public var supportsOAuth: Bool

	public init(toolCount: Int?, supportsOAuth: Bool) {
		self.toolCount = toolCount
		self.supportsOAuth = supportsOAuth
	}
}

public struct WorkspaceSkill: Identifiable, Sendable, Equatable {
	public var id: String
	public var name: String
	public var summary: String?
	public var isValid: Bool
	public init(id: String, name: String, summary: String?, isValid: Bool) {
		self.id = id
		self.name = name
		self.summary = summary
		self.isValid = isValid
	}
}
