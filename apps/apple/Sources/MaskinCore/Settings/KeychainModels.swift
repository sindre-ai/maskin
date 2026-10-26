import Foundation

/// One credential in the workspace Keychain (a pasted key, a login, or an OAuth connection an
/// agent may use). The value itself never reaches the app: only its name, kind and who may use it.
public struct KeychainCredential: Identifiable, Equatable, Sendable {
	public enum Kind: String, Sendable { case apiKey = "byo_apikey", login = "byo_login", oauth = "byo_oauth" }

	public var id: String
	public var name: String
	public var kind: Kind
	/// Saved by pasting it into a chat; the web shows a "Captured via chat" tag.
	public var capturedViaChat: Bool
	public var createdAt: Date?
	public var createdByID: String
	/// The agents that may use it, by actor id. Empty means no agent can: it fails closed.
	public var agentIDs: [String]

	public init(
		id: String, name: String, kind: Kind, capturedViaChat: Bool = false, createdAt: Date? = nil,
		createdByID: String = "", agentIDs: [String] = []
	) {
		self.id = id
		self.name = name
		self.kind = kind
		self.capturedViaChat = capturedViaChat
		self.createdAt = createdAt
		self.createdByID = createdByID
		self.agentIDs = agentIDs
	}

	public var kindLabel: String {
		switch kind {
		case .apiKey: "API key"
		case .login: "Login"
		case .oauth: "OAuth"
		}
	}
}

/// An agent a credential can be shared with.
public struct KeychainAgent: Identifiable, Equatable, Sendable {
	public var id: String
	public var name: String
	public init(id: String, name: String) {
		self.id = id
		self.name = name
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
