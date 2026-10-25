import Foundation
import MaskinAPI

/// An agent's ask to use a credential already in the Keychain (`metadata.keychain_access_request`,
/// put there by the `request_keychain_access` tool). It names the credential and holds no secret.
public struct KeychainAccessRequest: Equatable, Sendable {
	public enum Kind: String, Sendable { case apiKey = "api_key", login }

	public var sessionID: String
	public var integrationID: String
	public var credentialName: String
	public var kind: Kind
	public var hint: String?

	public init(
		sessionID: String, integrationID: String, credentialName: String, kind: Kind, hint: String? = nil
	) {
		self.sessionID = sessionID
		self.integrationID = integrationID
		self.credentialName = credentialName
		self.kind = kind
		self.hint = hint
	}

	/// The request on a message, or nil when it carries none (or an incomplete one).
	public init?(message: ChatMessage) {
		guard let raw = message.metadata?["keychain_access_request"],
			let sessionID = raw["session_id"]?.stringValue,
			let integrationID = raw["integration_id"]?.stringValue,
			let name = raw["credential_name"]?.stringValue, !name.isEmpty
		else { return nil }
		self.init(
			sessionID: sessionID, integrationID: integrationID, credentialName: name,
			kind: raw["kind"]?.stringValue.flatMap(Kind.init(rawValue:)) ?? .apiKey,
			hint: raw["hint"]?.stringValue)
	}

	/// What the person says back, as a plain message the agent reads on its fresh session.
	public func allowedReply(scope: KeychainAccessScope) -> String {
		"I've allowed you to use \(credentialName) from the Keychain"
			+ (scope == .chat ? " in this chat only" : "") + ". Please carry on."
	}

	public var declinedReply: String {
		"Not now: please don't use \(credentialName). Carry on without it, or tell me what you need instead."
	}
}

public enum KeychainAccessScope: String, Sendable, Equatable {
	case chat, always
}

/// Where the grant for one request stands, read from the credential list so a card scrolled back
/// to says what happened instead of offering the buttons again.
public enum KeychainAccessState: Equatable, Sendable {
	case unknown
	case ask
	case allowed(KeychainAccessScope)
	case gone
}

public protocol KeychainAccessing: Sendable {
	func state(for request: KeychainAccessRequest, agentID: String, conversationID: String) async
		-> KeychainAccessState
	/// Grants the asking agent the credential; true when the idle session was stopped so the
	/// reply message starts a fresh one that has it.
	func allow(_ request: KeychainAccessRequest, scope: KeychainAccessScope) async throws -> Bool
}

public struct KeychainAccessError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}

/// Production source over the generated client.
public struct APIKeychainAccessSource: KeychainAccessing {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func state(for request: KeychainAccessRequest, agentID: String, conversationID: String) async
		-> KeychainAccessState
	{
		guard
			let output = try? await client.get_sol_api_sol_integrations(
				.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID))),
			case .ok(let ok) = output, let rows = try? ok.body.json
		else { return .unknown }
		guard let row = rows.first(where: { $0.id == request.integrationID }) else { return .gone }
		if row.agentGrants?.contains(where: { $0.actorId == agentID && $0.access.rawValue != "none" }) == true {
			return .allowed(.always)
		}
		if row.chatGrants?.contains(where: { $0.actorId == agentID && $0.conversationId == conversationID })
			== true
		{
			return .allowed(.chat)
		}
		// Who may allow it (whoever saved it, or an admin) is the server's call; it answers 403.
		return .ask
	}

	public func allow(_ request: KeychainAccessRequest, scope: KeychainAccessScope) async throws -> Bool {
		let output = try await client.post_sol_api_sol_integrations_sol__lcub_id_rcub__sol_allow_hyphen_from_hyphen_chat(
			.init(
				path: .init(id: request.integrationID),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(.init(sessionId: request.sessionID, scope: scope == .chat ? .chat : .always))))
		switch output {
		case .ok(let ok):
			return try ok.body.json.relaunch == .stopped
		case .forbidden:
			throw KeychainAccessError("Only the person who saved this or a workspace admin can allow it.")
		default:
			throw KeychainAccessError("Couldn't allow it. Try again.")
		}
	}
}
