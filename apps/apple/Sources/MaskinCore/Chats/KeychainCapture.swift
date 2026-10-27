import Foundation
import MaskinAPI

/// An agent's ask for a secret it does not have (`metadata.keychain_request`, from the
/// `request_keychain_credential` tool). The person types the value into a card and it goes
/// straight to the vault: it never passes through the agent or the message.
public struct KeychainCredentialRequest: Equatable, Sendable {
	public typealias Kind = KeychainAccessRequest.Kind

	public var sessionID: String
	public var kind: Kind
	public var suggestedName: String?
	public var hint: String?
	/// A helper another agent started: not in this chat, so it is answered through its own session.
	public var replyToSession: Bool

	public init(
		sessionID: String, kind: Kind, suggestedName: String? = nil, hint: String? = nil,
		replyToSession: Bool = false
	) {
		self.sessionID = sessionID
		self.kind = kind
		self.suggestedName = suggestedName
		self.hint = hint
		self.replyToSession = replyToSession
	}

	/// What the person says back once saved; see `KeychainAccessRequest.allowedReply`.
	public func savedReply(name: String) -> String {
		let vars = KeychainCredentialName.envNames(kind: kind, name: name)
		let where_ = vars.isEmpty ? "" : ". It's in your environment as \(vars.joined(separator: " and "))"
		return "I've saved \(name) to the Keychain" + where_
			+ (replyToSession ? ". Carry on with the work." : ". Reply with one short line to say you have it, then carry on.")
	}

	public init?(message: ChatMessage) {
		guard let raw = message.metadata?["keychain_request"], let sessionID = raw["session_id"]?.stringValue
		else { return nil }
		self.init(
			sessionID: sessionID, kind: raw["kind"]?.stringValue.flatMap(Kind.init(rawValue:)) ?? .apiKey,
			suggestedName: raw["suggested_name"]?.stringValue, hint: raw["hint"]?.stringValue,
			replyToSession: raw["reply_to_session"]?.boolValue == true)
	}
}

/// The name rules the server and the web card share, so a bad name is caught before the value
/// is sent. The server still has the last word (it also refuses names that look like secrets).
public enum KeychainCredentialName {
	public static let maxLength = 64

	/// Why `name` can't be used, in words for the person; nil when it can.
	public static func problem(_ name: String) -> String? {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return "Give the credential a name." }
		if trimmed.count > maxLength { return "Names can be up to \(maxLength) characters." }
		if trimmed.unicodeScalars.contains(where: { $0 == "[" || $0 == "]" || $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) {
			return "Names can't contain square brackets or control characters."
		}
		if slug(trimmed).isEmpty { return "Use at least one letter or number in the name." }
		return nil
	}

	/// The identifier in the env var name: upper case, runs of anything else become one `_`, at most 48.
	public static func slug(_ name: String) -> String {
		var out = ""
		var pendingBreak = false
		for scalar in name.uppercased().unicodeScalars {
			if ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar) {
				if pendingBreak, !out.isEmpty { out.append("_") }
				pendingBreak = false
				out.unicodeScalars.append(scalar)
			} else {
				pendingBreak = true
			}
		}
		var capped = String(out.prefix(48))
		while capped.hasSuffix("_") { capped.removeLast() }
		return capped
	}

	/// The env vars an agent reads the saved credential from.
	public static func envNames(kind: KeychainCredentialRequest.Kind, name: String) -> [String] {
		let slug = slug(name)
		guard !slug.isEmpty else { return [] }
		switch kind {
		case .login: return ["KEYCHAIN_BYO_LOGIN_\(slug)_USERNAME", "KEYCHAIN_BYO_LOGIN_\(slug)_PASSWORD"]
		case .apiKey: return ["KEYCHAIN_BYO_APIKEY_\(slug)"]
		}
	}
}

/// What the person typed. The values are cleared by the caller as soon as the save returns.
public struct KeychainCredentialInput: Sendable {
	public enum Value: Sendable {
		case apiKey(String)
		case login(username: String, password: String)
	}
	public var displayName: String
	public var value: Value
	/// The agents that may use it: everyone in the chat unless the person unticks one.
	public var agentIDs: [String]

	public init(displayName: String, value: Value, agentIDs: [String]) {
		self.displayName = displayName
		self.value = value
		self.agentIDs = agentIDs
	}
}

public protocol KeychainCapturing: Sendable {
	/// The name of a credential already saved from this card (a reload, another device), if any.
	func savedName(for request: KeychainCredentialRequest, after: Date?) async -> String?
	/// Saves the credential; true when the agent's idle session was stopped so the reply starts a fresh one.
	func save(_ input: KeychainCredentialInput, for request: KeychainCredentialRequest) async throws -> Bool
}

/// Production source. `chat-capture` has no request body in the API description on purpose (the
/// server reads and zeroes the raw bytes), so the generated client cannot call it: this builds the
/// request by hand. Nothing here logs or keeps a value, and errors name fields, never values.
public struct APIKeychainCaptureSource: KeychainCapturing {
	private let client: Client
	private let workspaceID: String
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		client: Client, workspaceID: String, baseURL: URL, clientSource: String,
		credentials: @escaping MaskinCredentialsProvider, session: URLSession = .shared
	) {
		self.client = client
		self.workspaceID = workspaceID
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func savedName(for request: KeychainCredentialRequest, after: Date?) async -> String? {
		guard
			let output = try? await client.get_sol_api_sol_integrations(
				.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID))),
			case .ok(let ok) = output, let rows = try? ok.body.json
		else { return nil }
		let mode = request.kind == .login ? "byo_login" : "byo_apikey"
		return rows.first { row in
			guard row.source == "chat_capture", row.originSessionId == request.sessionID,
				row.providerMode?.rawValue == mode, row.status != "undone"
			else { return false }
			guard let after else { return true }
			return ChatDates.parse(row.createdAt).map { $0 >= after } ?? false
		}?.displayName
	}

	/// The `chat-capture` body. The server's schema is strict (an extra field is a 400), so each shape
	/// carries exactly the fields it names: a key also names its provider, a login does not.
	static func captureBody(_ input: KeychainCredentialInput, sessionID: String) -> [String: Any] {
		var body: [String: Any] = [
			"sessionId": sessionID, "displayName": input.displayName, "fromCard": true, "agentIds": input.agentIDs,
		]
		switch input.value {
		case .apiKey(let secret):
			body["providerMode"] = "byo_apikey"
			body["detectedProvider"] = "manual"
			body["rawSecret"] = secret
		case .login(let username, let password):
			body["providerMode"] = "byo_login"
			body["username"] = username
			body["password"] = password
		}
		return body
	}

	/// The most agents the server accepts on one capture.
	static let maxAgents = 25

	public func save(_ input: KeychainCredentialInput, for request: KeychainCredentialRequest) async throws -> Bool {
		guard input.agentIDs.count <= Self.maxAgents else {
			throw KeychainAccessError("Pick up to \(Self.maxAgents) agents to share it with.")
		}
		let body = Self.captureBody(input, sessionID: request.sessionID)
		var urlRequest = URLRequest(url: baseURL.appendingPathComponent("api/integrations/chat-capture"))
		urlRequest.httpMethod = "POST"
		urlRequest.timeoutInterval = 30
		urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
		urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
		urlRequest.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		urlRequest.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
		if let creds = await credentials() {
			urlRequest.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			urlRequest.setValue(creds.workspaceId ?? workspaceID, forHTTPHeaderField: "X-Workspace-Id")
		}
		urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: urlRequest)
		} catch {
			throw KeychainAccessError("Couldn't reach Maskin. Check your connection and try again.")
		}
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(status) else { throw KeychainAccessError(Self.failure(status: status, body: data)) }
		struct Saved: Decodable { var relaunch: String }
		return (try? JSONDecoder().decode(Saved.self, from: data))?.relaunch == "stopped"
	}

	static func failure(status: Int, body: Data) -> String {
		struct Envelope: Decodable {
			struct Detail: Decodable { var message: String? }
			var error: Detail?
		}
		let message = (try? JSONDecoder().decode(Envelope.self, from: body))?.error?.message
		// The server's reason where it gives one: a 403 is not always "not a person" (a viewer role
		// gets one too), and a missing session or a taken name each say what to do.
		switch status {
		case 403: return message ?? "You can't save a credential here."
		case 400, 404, 409, 422: return "Couldn't save: \(message ?? "check the name and the value, then try again.")"
		default: return "Couldn't save. Try again."
		}
	}
}
