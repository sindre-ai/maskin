import Foundation
import MaskinAPI

/// An agent's ask to add a tool (MCP) server (`metadata.mcp_server_request`, put there by the
/// `add_mcp_server` tool). It holds what the agent knows (the command or address, values that are
/// not secret) and only the *names* of what the person must type. The person types those into the
/// card and they go straight into the server's settings: they never pass through the agent or the
/// message.
public struct McpServerRequest: Equatable, Sendable {
	public var sessionID: String
	public var name: String
	public var hint: String?
	public var type: String?
	public var command: String?
	public var args: [String]
	public var url: String?
	/// Values the agent may know (not secret): a region, or a Keychain reference.
	public var env: [String: String]
	public var headers: [String: String]
	/// Names the person types the value for.
	public var secretEnv: [String]
	public var secretHeaders: [String]
	/// A helper another agent started: not in this chat, so it is answered through its own session.
	public var replyToSession: Bool

	public init(
		sessionID: String, name: String, hint: String? = nil, type: String? = nil, command: String? = nil,
		args: [String] = [], url: String? = nil, env: [String: String] = [:], headers: [String: String] = [:],
		secretEnv: [String] = [], secretHeaders: [String] = [], replyToSession: Bool = false
	) {
		self.sessionID = sessionID
		self.name = name
		self.hint = hint
		self.type = type
		self.command = command
		self.args = args
		self.url = url
		self.env = env
		self.headers = headers
		self.secretEnv = secretEnv
		self.secretHeaders = secretHeaders
		self.replyToSession = replyToSession
	}

	/// The request on a message, or nil when it carries none (or an incomplete one).
	public init?(message: ChatMessage) {
		guard let raw = message.metadata?["mcp_server_request"],
			let sessionID = raw["session_id"]?.stringValue,
			let name = raw["name"]?.stringValue, !name.isEmpty
		else { return nil }
		func strings(_ key: String) -> [String] { raw[key]?.arrayValue?.compactMap(\.stringValue) ?? [] }
		func pairs(_ key: String) -> [String: String] {
			guard case .object(let object)? = raw[key] else { return [:] }
			return object.compactMapValues(\.stringValue)
		}
		self.init(
			sessionID: sessionID, name: name, hint: raw["hint"]?.stringValue, type: raw["type"]?.stringValue,
			command: raw["command"]?.stringValue, args: strings("args"), url: raw["url"]?.stringValue,
			env: pairs("env"), headers: pairs("headers"), secretEnv: strings("secret_env"),
			secretHeaders: strings("secret_headers"), replyToSession: raw["reply_to_session"]?.boolValue == true)
	}

	/// The command that would run inside the agent, for the person to check before adding. Always
	/// shown when there is one, so the card never hides what Add saves.
	public var commandLine: String? {
		guard let command else { return nil }
		return ([command] + args).joined(separator: " ")
	}

	/// The values the agent gave, as `NAME=value` lines (sorted, so the card does not reorder).
	public var givenValues: [String] {
		(env.sorted { $0.key < $1.key } + headers.sorted { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }
	}

	/// True once every secret has a value.
	public func isComplete(env typedEnv: [String: String], headers typedHeaders: [String: String]) -> Bool {
		secretEnv.allSatisfy { !(typedEnv[$0] ?? "").isEmpty } && secretHeaders.allSatisfy { !(typedHeaders[$0] ?? "").isEmpty }
	}

	/// The server to save: what the agent gave, plus the secrets the person typed.
	public func server(env typedEnv: [String: String], headers typedHeaders: [String: String]) -> JSONValue {
		var server: [String: JSONValue] = [:]
		if let type { server["type"] = .string(type) }
		if let command { server["command"] = .string(command) }
		if !args.isEmpty { server["args"] = .array(args.map(JSONValue.string)) }
		if let url { server["url"] = .string(url) }
		let allEnv = env.merging(typedEnv) { _, typed in typed }
		let allHeaders = headers.merging(typedHeaders) { _, typed in typed }
		if !allEnv.isEmpty { server["env"] = .object(allEnv.mapValues(JSONValue.string)) }
		if !allHeaders.isEmpty { server["headers"] = .object(allHeaders.mapValues(JSONValue.string)) }
		return .object(server)
	}

	/// What the person says back once added, as a message the agent reads on its fresh session. In a
	/// chat it asks for one short line, so the person sees the agent has it; a helper just carries on.
	public func addedReply(name: String) -> String {
		"I've added the \(name) tool server for you. Carry on with the work."
			+ (replyToSession ? "" : " Reply with one short line to say you have it.")
	}

	public var declinedReply: String {
		"Not now: please don't add the \(name) tool server yet. Carry on without it, or tell me what you need instead."
	}
}

/// A server already added for a request (a reload, another device), and whether the asking agent has it.
public struct AddedMcpServer: Equatable, Sendable {
	public var id: String
	public var name: String
	/// False when saving worked but giving it to the agent did not: only that step is left.
	public var givenToAgent: Bool

	public init(id: String, name: String, givenToAgent: Bool) {
		self.id = id
		self.name = name
		self.givenToAgent = givenToAgent
	}
}

public protocol McpServerAdding: Sendable {
	/// The server added for this request since the card was posted, if any.
	func addedServer(for request: McpServerRequest, agentID: String, after: Date?) async -> AddedMcpServer?
	/// Saves the server (a person only) and returns its id. The typed secrets are in `server`.
	func save(name: String, server: JSONValue) async throws -> String
	/// Gives the asking agent the server; true when the idle session was stopped so the reply
	/// starts a fresh one that has it.
	func allow(serverID: String, for request: McpServerRequest) async throws -> Bool
}

/// Production source. The request bodies are free-form (a server's env and headers are open
/// records), so this builds them by hand like `APIKeychainCaptureSource`. Nothing here logs or
/// keeps a value, and errors name fields, never values.
public struct APIMcpServerSource: McpServerAdding {
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

	public func addedServer(for request: McpServerRequest, agentID: String, after: Date?) async
		-> AddedMcpServer?
	{
		guard
			let output = try? await client.get_sol_api_sol_integrations(
				.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID))),
			case .ok(let ok) = output, let rows = try? ok.body.json
		else { return nil }
		guard
			let row = rows.first(where: { row in
				guard row.provider == "custom-mcp", row.status == "active", row.displayName == request.name else {
					return false
				}
				guard let after else { return true }
				return ChatDates.parse(row.createdAt).map { $0 >= after } ?? false
			})
		else { return nil }
		let given = row.agentGrants?.contains { $0.actorId == agentID && $0.access.rawValue != "none" } == true
		return AddedMcpServer(id: row.id, name: row.displayName ?? request.name, givenToAgent: given)
	}

	public func save(name: String, server: JSONValue) async throws -> String {
		let data = try await post("api/custom-mcp-servers", .object(["name": .string(name), "server": server])) { status, message in
			switch status {
			case 403: return "Only a person can add a tool server."
			case 400, 409, 422: return "Couldn't add: \(message ?? "check the name and the details, then try again.")"
			default: return "Couldn't add. Try again."
			}
		}
		struct Saved: Decodable { var id: String }
		guard let saved = try? JSONDecoder().decode(Saved.self, from: data) else {
			throw KeychainAccessError("Couldn't add. Try again.")
		}
		return saved.id
	}

	public func allow(serverID: String, for request: McpServerRequest) async throws -> Bool {
		let data = try await post(
			"api/integrations/\(serverID)/allow-access",
			.object(["sessionId": .string(request.sessionID), "level": .string("read_write")])
		) { status, _ in
			status == 403
				? "Only the person who added this or a workspace admin can give it to the agent."
				: "The server is added, but couldn't be given to the agent. Try again."
		}
		struct Allowed: Decodable { var relaunch: String }
		return (try? JSONDecoder().decode(Allowed.self, from: data))?.relaunch == "stopped"
	}

	private func post(
		_ path: String, _ body: JSONValue, failure: (Int, String?) -> String
	) async throws -> Data {
		var urlRequest = URLRequest(url: baseURL.appendingPathComponent(path))
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
		urlRequest.httpBody = try JSONEncoder().encode(body)
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: urlRequest)
		} catch {
			throw KeychainAccessError("Couldn't reach Maskin. Check your connection and try again.")
		}
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(status) else {
			struct Envelope: Decodable {
				struct Detail: Decodable { var message: String? }
				var error: Detail?
			}
			let message = (try? JSONDecoder().decode(Envelope.self, from: data))?.error?.message
			throw KeychainAccessError(failure(status, message))
		}
		return data
	}
}
