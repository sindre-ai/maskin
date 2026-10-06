import Foundation

/// A failure with a sentence a person can read. Carries no ids, tokens or response bodies.
public struct SettingsError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
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
