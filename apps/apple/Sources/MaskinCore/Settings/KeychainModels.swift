import Foundation

/// How an agent's explicit row on a credential reads. A saved key or login is on or off: `none` is
/// off, anything else is on (read and write).
public enum KeychainGrant: String, Sendable, Equatable {
	case none, read
	case readWrite = "read_write"
}

/// One credential in the workspace Keychain (a pasted key, a login, or an OAuth connection an
/// agent may use). The value itself never reaches the app: only its name, kind and who may use it.
public struct KeychainCredential: Identifiable, Equatable, Sendable {
	public enum Kind: String, Sendable { case apiKey = "byo_apikey", login = "byo_login", oauth = "byo_oauth" }

	public var id: String
	public var name: String
	public var kind: Kind
	/// `active` once saved; `pending_undo` while a chat capture can still be undone.
	public var status: String
	/// Saved by pasting it into a chat; the web shows a "Captured via chat" tag.
	public var capturedViaChat: Bool
	public var createdAt: Date?
	public var createdByID: String
	/// An agent's explicit row, by actor id. A `none` row is off, not "no row".
	public var grants: [String: KeychainGrant]
	/// What an agent with no row of its own gets. The server's default "read" means on for every
	/// agent; anything else means off. This is why "empty grants" is not "no agent can use it".
	public var defaultOn: Bool

	public init(
		id: String, name: String, kind: Kind, status: String = "active", capturedViaChat: Bool = false,
		createdAt: Date? = nil, createdByID: String = "", grants: [String: KeychainGrant] = [:],
		defaultOn: Bool = false
	) {
		self.id = id
		self.name = name
		self.kind = kind
		self.status = status
		self.capturedViaChat = capturedViaChat
		self.createdAt = createdAt
		self.createdByID = createdByID
		self.grants = grants
		self.defaultOn = defaultOn
	}

	/// Whether this agent may use it, as the server decides: its own row if it has one, else the default.
	public func allows(_ agentID: String) -> Bool {
		if let grant = grants[agentID] { return grant != .none }
		return defaultOn
	}

	public var isActive: Bool { status == "active" }

	/// Who may use it can be changed for a saved key or login that is live; not an OAuth connection,
	/// and not one still inside its undo window (the server refuses both).
	public var canEditAccess: Bool { kind != .oauth && isActive }

	public var kindLabel: String {
		switch kind {
		case .apiKey: "API key"
		case .login: "Login"
		case .oauth: "OAuth"
		}
	}
}

/// Someone in the workspace: an agent a credential can be shared with, or a person in its activity.
public struct KeychainMember: Identifiable, Equatable, Sendable {
	public var id: String
	public var name: String
	public var isAgent: Bool
	public init(id: String, name: String, isAgent: Bool) {
		self.id = id
		self.name = name
		self.isAgent = isAgent
	}
}

/// One line of a credential's activity: every read by an agent, and every change.
public struct KeychainAuditEntry: Identifiable, Equatable, Sendable {
	public enum Action: String, Sendable {
		case read, create, undone, rotated
		case sweeperActivated = "sweeper_activated"
		case scopeChanged = "scope_changed"
	}

	public var id: String
	public var actorID: String
	public var action: Action?
	public var sessionID: String?
	public var outboundTarget: String?
	public var viaChat: Bool
	public var at: Date?

	public init(
		id: String, actorID: String, action: Action?, sessionID: String? = nil, outboundTarget: String? = nil,
		viaChat: Bool = false, at: Date? = nil
	) {
		self.id = id
		self.actorID = actorID
		self.action = action
		self.sessionID = sessionID
		self.outboundTarget = outboundTarget
		self.viaChat = viaChat
		self.at = at
	}

	/// One plain sentence, with an actor's name where the web names them.
	public func sentence(actorName: String) -> String {
		switch action {
		case .create: viaChat ? "Captured via chat: vaulted and redacted from the transcript." : "\(actorName) added this credential."
		case .read:
			"\(actorName) read this credential" + (sessionID.map { " for session \($0.prefix(8))" } ?? "")
				+ (outboundTarget.map { " targeting \($0)" } ?? "") + "."
		case .undone: "\(actorName) removed this credential. The secret is destroyed."
		case .rotated: "\(actorName) rotated this credential."
		case .sweeperActivated: "The undo window closed. This credential is now permanent."
		case .scopeChanged: "\(actorName) changed which agents can use this credential."
		case nil: "\(actorName) changed this credential."
		}
	}
}

public struct KeychainAuditPage: Equatable, Sendable {
	public var entries: [KeychainAuditEntry]
	public var nextBeforeID: String?
	public init(entries: [KeychainAuditEntry], nextBeforeID: String?) {
		self.entries = entries
		self.nextBeforeID = nextBeforeID
	}
}

/// What the person typed into the add form. Cleared by the caller as soon as the save returns.
public enum KeychainNewValue: Sendable {
	case apiKey(String)
	case login(username: String, password: String)
}
