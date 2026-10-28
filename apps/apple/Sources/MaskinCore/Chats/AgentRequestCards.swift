import Foundation
import MaskinAPI

// The cards an agent puts in chat besides the Keychain ones. The web draws all of them from
// message metadata; native reads the same keys.

/// An agent's ask to connect a provider (`metadata.integration_connect`, from `connect_integration`).
public struct IntegrationConnectRequest: Equatable, Sendable {
	/// The provider slug the agent asked for, e.g. `linear`.
	public var provider: String

	public init(provider: String) { self.provider = provider }

	public init?(message: ChatMessage) {
		guard let provider = message.metadata?["integration_connect"]?["provider"]?.stringValue, !provider.isEmpty
		else { return nil }
		self.provider = provider
	}
}

/// An agent asking the person to act on its own computer (`metadata.computer_request`, from
/// `show_computer`): a 2FA prompt, a CAPTCHA, a confirmation.
public struct ComputerRequest: Equatable, Sendable {
	public var sessionID: String
	public var task: String
	/// A helper another agent started: Done goes to its own session, not the chat.
	public var replyToSession: Bool

	/// What a Done press tells the agent. Sent hidden, so the chat does not show it.
	public static let doneMessage = "Done: I've finished on the computer. Please take a screenshot and carry on."

	public init?(message: ChatMessage) {
		guard let raw = message.metadata?["computer_request"], let sessionID = raw["session_id"]?.stringValue,
			let task = raw["task"]?.stringValue
		else { return nil }
		self.sessionID = sessionID
		self.task = task
		self.replyToSession = raw["reply_to_session"]?.boolValue == true
	}
}

/// An agent's ask for access to an integration that is connected but not allowed for it
/// (`metadata.integration_access_request`, from `request_integration_access`).
public struct IntegrationAccessRequest: Equatable, Sendable {
	public enum Level: String, Sendable {
		case read, readWrite = "read_write"

		/// "none" < "read" < "read_write", for comparing what an agent has with what it asked for.
		var rank: Int { self == .read ? 1 : 2 }
		public var words: String { self == .readWrite ? "read and write access" : "read access" }
	}

	public var sessionID: String
	public var integrationID: String
	public var displayName: String
	public var level: Level
	public var reason: String?
	/// A helper another agent started: answered through its own session, not the chat.
	public var replyToSession: Bool

	public init?(message: ChatMessage) {
		guard let raw = message.metadata?["integration_access_request"],
			let sessionID = raw["session_id"]?.stringValue,
			let integrationID = raw["integration_id"]?.stringValue,
			let name = raw["display_name"]?.stringValue, !name.isEmpty,
			let level = raw["level"]?.stringValue.flatMap(Level.init(rawValue:))
		else { return nil }
		self.sessionID = sessionID
		self.integrationID = integrationID
		self.displayName = name
		self.level = level
		self.reason = raw["reason"]?.stringValue
		self.replyToSession = raw["reply_to_session"]?.boolValue == true
	}

	/// What the person says back after an Allow, worded as the web does. `changed` is false when the
	/// agent already had it. In a chat the agent is also asked for one short line, so the person
	/// sees it has the access; a helper just carries on.
	public func allowedReply(changed: Bool) -> String {
		let head =
			changed
			? "I've allowed you \(level.words) to \(displayName). Carry on with the work."
			: "You already have \(level.words) to \(displayName). Carry on with the work."
		return replyToSession ? head : head + " Reply with one short line to say you have it."
	}

	public var declinedReply: String {
		"Not now: please don't use \(displayName) yet. Carry on without it, or tell me what you need instead."
	}
}

/// Where an access request stands, read from the integration list so a card scrolled back to
/// says what happened instead of offering the buttons again.
public enum IntegrationAccessState: Equatable, Sendable {
	case unknown
	case ask
	case allowed
	/// Disconnected or removed since the agent asked.
	case gone
}

public struct IntegrationAccessResult: Equatable, Sendable {
	/// False when the agent already had at least that access.
	public var changed: Bool
	/// True when the idle session was stopped, so the reply starts a fresh one that knows its new access.
	public var relaunched: Bool
}

public protocol IntegrationAccessing: Sendable {
	func state(for request: IntegrationAccessRequest, agentID: String) async -> IntegrationAccessState
	func allow(_ request: IntegrationAccessRequest) async throws -> IntegrationAccessResult
}

public struct APIIntegrationAccessSource: IntegrationAccessing {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func state(for request: IntegrationAccessRequest, agentID: String) async -> IntegrationAccessState {
		guard
			let output = try? await client.get_sol_api_sol_integrations(
				.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID))),
			case .ok(let ok) = output, let rows = try? ok.body.json
		else { return .unknown }
		guard let row = rows.first(where: { $0.id == request.integrationID }), row.status == "active" else {
			return .gone
		}
		// An agent's own entry wins over the default for agents without one.
		let own = row.agentGrants?.first { $0.actorId == agentID }?.access.rawValue
		let current = own ?? row.defaultAgentAccess?.rawValue ?? "none"
		let rank = ["none": 0, "read": 1, "read_write": 2][current] ?? 0
		return rank >= request.level.rank ? .allowed : .ask
	}

	public func allow(_ request: IntegrationAccessRequest) async throws -> IntegrationAccessResult {
		let output = try await client.post_sol_api_sol_integrations_sol__lcub_id_rcub__sol_allow_hyphen_access(
			.init(
				path: .init(id: request.integrationID),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(.init(sessionId: request.sessionID, level: request.level == .read ? .read : .read_write))))
		switch output {
		case .ok(let ok):
			let body = try ok.body.json
			return IntegrationAccessResult(changed: body.changed, relaunched: body.relaunch == .stopped)
		case .forbidden:
			throw KeychainAccessError("Only the person who connected this or a workspace admin can allow it.")
		// The server says why (a custom tool server asked for read access, the session is gone, the
		// connection is no longer active), as the web's card does; "try again" would never work.
		case .badRequest(let bad):
			throw KeychainAccessError(Self.refusal((try? bad.body.json)?.error.message))
		case .notFound(let missing):
			throw KeychainAccessError(Self.refusal((try? missing.body.json)?.error.message))
		case .conflict(let conflict):
			throw KeychainAccessError(Self.refusal((try? conflict.body.json)?.error.message))
		default:
			throw KeychainAccessError("Couldn't allow it. Try again.")
		}
	}

	static func refusal(_ serverMessage: String?) -> String {
		serverMessage.map { "Couldn't allow: \($0)" } ?? "Couldn't allow it. Try again."
	}
}

extension ChatMessage {
	/// This message carries a card whose answer is recorded as a `card_answer` (so reading the
	/// answer back is only worth doing for these).
	public var asksForAnswer: Bool {
		metadata?["keychain_access_request"] != nil || metadata?["integration_access_request"] != nil
			|| metadata?["computer_request"] != nil
	}
}
