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
	/// A helper another agent started: not in this chat, so it is answered through its own session.
	public var replyToSession: Bool

	public init(
		sessionID: String, integrationID: String, credentialName: String, kind: Kind, hint: String? = nil,
		replyToSession: Bool = false
	) {
		self.sessionID = sessionID
		self.integrationID = integrationID
		self.credentialName = credentialName
		self.kind = kind
		self.hint = hint
		self.replyToSession = replyToSession
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
			hint: raw["hint"]?.stringValue, replyToSession: raw["reply_to_session"]?.boolValue == true)
	}

	/// What the person says back, as a message the agent reads on its fresh session. In a chat it
	/// asks for one short line, so the person sees the agent has it; a helper just carries on.
	public func allowedReply(scope: KeychainAccessScope) -> String {
		let vars = KeychainCredentialName.envNames(kind: kind, name: credentialName)
		let where_ = vars.isEmpty ? "" : ". It's in your environment as \(vars.joined(separator: " and "))"
		let head = "I've allowed you to use \(credentialName) from the Keychain"
		if replyToSession { return head + where_ + ". Carry on with the work." }
		return head + (scope == .chat ? " in this chat only" : "") + where_
			+ ". Reply with one short line to say you have it, then carry on."
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

/// Answers an agent that a helper started (`reply_to_session`): it is not in this chat, so the
/// person's reply goes to its own session. `continueSession` starts a follow-up for a helper
/// that has ended, which is what Allow and Save do (the grant stops its idle session);
/// `sendInput` is a turn into a live one, which is what a decline does.
public protocol HelperSessionReplying: Sendable {
	func continueSession(sessionID: String, content: String) async throws
	func sendInput(sessionID: String, content: String, cardAnswer: ChatCardAnswer) async throws
}

public struct APIHelperSessionSource: HelperSessionReplying {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func continueSession(sessionID: String, content: String) async throws {
		let output = try await client.post_sol_api_sol_sessions_sol__lcub_id_rcub__sol_continue(
			.init(
				path: .init(id: sessionID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(.init(content: content))))
		guard case .created = output else { throw KeychainAccessError("Couldn't reach the agent. Try again.") }
	}

	public func sendInput(sessionID: String, content: String, cardAnswer: ChatCardAnswer) async throws {
		let output = try await client.post_sol_api_sol_sessions_sol__lcub_id_rcub__sol_input(
			.init(
				path: .init(id: sessionID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(
					.init(
						content: content,
						card_answer: .init(
							message_id: cardAnswer.messageID,
							outcome: cardAnswer.outcome == .declined ? .declined : .done)))))
		guard case .ok = output else { throw KeychainAccessError("Couldn't reach the agent. Try again.") }
	}
}
