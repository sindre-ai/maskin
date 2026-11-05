import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production source for the Agents stores. Generated operation names stay in this file;
/// everything above sees the protocols in `AgentsAPI.swift` and plain models.
public struct APIAgentsSource: AgentsAPI, AgentDetailAPI {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	// MARK: - List

	public func agents() async throws -> [AgentSummary] {
		var all: [AgentSummary] = []
		var offset = 0
		let pageSize = 100
		while offset < 10_000 {
			let output = try await client.get_sol_api_sol_actors(
				.init(
					query: .init(limit: pageSize, offset: offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .ok(let ok) = output else { throw AgentsError("Couldn't load agents.") }
			let rows = try ok.body.json
			all += rows.filter { $0._type == "agent" }.map { row in
				AgentSummary(
					id: row.id, name: row.name, description: row.description, isSystem: row.isSystem,
					storedState: Self.state(row.agentState.rawValue),
					createdAt: ChatDates.parse(row.createdAt))
			}
			if rows.count < pageSize { break }
			offset += pageSize
		}
		return all
	}

	public func recentSessions(limit: Int) async throws -> [AgentSession] {
		try await sessionRows(agentID: nil, limit: limit)
	}

	public func latestSession(agentID: String) async throws -> AgentSession? {
		try await sessionRows(agentID: agentID, limit: 1).first
	}

	// MARK: - Detail

	public func profile(agentID: String) async throws -> AgentProfile {
		let output = try await client.get_sol_api_sol_actors_sol__lcub_id_rcub_(
			.init(
				path: .init(id: agentID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			let row = try ok.body.json
			return AgentProfile(
				id: row.id, name: row.name, description: row.description,
				systemPrompt: row.system_prompt, llmProvider: row.llm_provider,
				tools: AgentTool.summarize(Self.json(row.tools)),
				skills: (row.skills ?? []).map(\.name), isSystem: row.isSystem,
				storedState: Self.state(row.agentState.rawValue),
				createdAt: ChatDates.parse(row.createdAt), updatedAt: ChatDates.parse(row.updatedAt))
		default:
			throw AgentsError("Couldn't open this agent.")
		}
	}

	public func sessions(agentID: String, limit: Int) async throws -> [AgentSession] {
		try await sessionRows(agentID: agentID, limit: limit)
	}

	public func run(agentID: String, prompt: String?, idempotencyKey: String) async throws -> AgentStatus {
		let output = try await IdempotencyKey.bind(idempotencyKey) {
			try await client.post_sol_api_sol_actors_sol__lcub_id_rcub__sol_run(
				.init(
					path: .init(id: agentID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(.init(action_prompt: prompt))))
		}
		switch output {
		case .ok(let ok): return Self.state(try ok.body.json.agentState.rawValue)
		case .badRequest: throw AgentsError("This agent can't run right now.")
		default: throw AgentsError("Couldn't run the agent.")
		}
	}

	public func pause(agentID: String, idempotencyKey: String) async throws -> AgentStatus {
		let output = try await IdempotencyKey.bind(idempotencyKey) {
			try await client.post_sol_api_sol_actors_sol__lcub_id_rcub__sol_pause(
				.init(
					path: .init(id: agentID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		}
		switch output {
		case .ok(let ok): return Self.state(try ok.body.json.agentState.rawValue)
		case .badRequest: throw AgentsError("This agent can't be paused right now.")
		default: throw AgentsError("Couldn't pause the agent.")
		}
	}

	public func reset(agentID: String, idempotencyKey: String) async throws -> AgentStatus {
		let output = try await IdempotencyKey.bind(idempotencyKey) {
			try await client.post_sol_api_sol_actors_sol__lcub_id_rcub__sol_reset(
				.init(
					path: .init(id: agentID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		}
		switch output {
		case .ok(let ok): return Self.state(try ok.body.json.agentState.rawValue)
		case .forbidden: throw AgentsError("Only built-in agents can be reset.")
		default: throw AgentsError("Couldn't reset the agent.")
		}
	}

	public func stop(sessionID: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.bind(idempotencyKey) {
			try await client.post_sol_api_sol_sessions_sol__lcub_id_rcub__sol_stop(
				.init(
					path: .init(id: sessionID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		}
		guard case .ok = output else { throw AgentsError("Couldn't stop the session.") }
	}

	public func update(agentID: String, edit: AgentEdit, idempotencyKey: String) async throws
		-> AgentProfile
	{
		var fields: [String: JSONValue] = [:]
		if let name = edit.name { fields["name"] = .string(name) }
		if let description = edit.description { fields["description"] = .string(description) }
		if let prompt = edit.systemPrompt { fields["system_prompt"] = .string(prompt) }
		if let tools = edit.tools { fields["tools"] = AgentTool.toolsJSON(tools) }
		let payload = try Self.wire(
			fields, as: Operations.patch_sol_api_sol_actors_sol__lcub_id_rcub_.Input.Body.jsonPayload.self)
		let output = try await IdempotencyKey.bind(idempotencyKey) {
			try await client.patch_sol_api_sol_actors_sol__lcub_id_rcub_(
				.init(
					path: .init(id: agentID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(payload)))
		}
		switch output {
		case .ok: return try await profile(agentID: agentID)
		case .notFound: throw AgentsError("This agent no longer exists.")
		default: throw AgentsError("Couldn't save your changes.")
		}
	}

	public func delete(agentID: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.bind(idempotencyKey) {
			try await client.delete_sol_api_sol_actors_sol__lcub_id_rcub_(
				.init(path: .init(id: agentID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		}
		switch output {
		case .ok: return
		case .forbidden: throw AgentsError("This agent can't be deleted.")
		default: throw AgentsError("Couldn't delete the agent.")
		}
	}

	/// One call: the server makes an agent that is given `workspace_id` a member in the same
	/// transaction, so there is no half-made agent outside the workspace. The caller's key is
	/// also the agent's id. The server does not cache this response (it carries the new agent's
	/// API key), so the Idempotency-Key cannot dedupe a retry; a fixed id can: a retry after a
	/// lost response hits "already exists" and is the agent we made.
	public func create(draft: AgentDraft, idempotencyKey: String) async throws -> AgentSummary {
		let agentID = UUID(uuidString: idempotencyKey)?.uuidString.lowercased()
		var fields: [String: JSONValue] = [
			"type": .string("agent"), "name": .string(draft.trimmedName),
			"workspace_id": .string(workspaceID),
		]
		if let agentID { fields["id"] = .string(agentID) }
		if !draft.trimmedDescription.isEmpty { fields["description"] = .string(draft.trimmedDescription) }
		if !draft.systemPrompt.isEmpty { fields["system_prompt"] = .string(draft.systemPrompt) }
		let payload = try Self.wire(
			fields, as: Operations.post_sol_api_sol_actors.Input.Body.jsonPayload.self)
		let created = try await IdempotencyKey.bind(idempotencyKey) {
			try await client.post_sol_api_sol_actors(.init(body: .json(payload)))
		}
		let id: String
		switch created {
		case .created(let ok): id = try ok.body.json.id
		case .badRequest: throw AgentsError("That name or description isn't valid.")
		case .conflict:
			// Our own id already exists: an earlier try of this same create got through.
			guard let agentID else { throw AgentsError("An agent with those details already exists.") }
			id = agentID
		default: throw AgentsError("Couldn't create the agent.")
		}
		return AgentSummary(
			id: id, name: draft.trimmedName,
			description: draft.trimmedDescription.isEmpty ? nil : draft.trimmedDescription,
			createdAt: Date())
	}

	// MARK: - Mapping

	/// Builds a generated request payload from plain JSON, so the deeply nested `tools` types
	/// never leak out of this file.
	private static func wire<T: Decodable>(_ fields: [String: JSONValue], as type: T.Type) throws -> T {
		let data = try JSONEncoder().encode(JSONValue.object(fields))
		return try JSONDecoder().decode(type, from: data)
	}

	private func sessionRows(agentID: String?, limit: Int) async throws -> [AgentSession] {
		let output = try await client.get_sol_api_sol_sessions(
			.init(
				query: .init(actor_id: agentID, verbose: true, limit: limit),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw AgentsError("Couldn't load sessions.") }
		// verbose=true asks for the full rows (the default is the lean list shape).
		return (try ok.body.json.value1 ?? []).map { row in
			AgentSession(
				id: row.id, actorID: row.actorId, status: row.status, prompt: row.actionPrompt,
				currentActivity: row.currentActivity, interactive: row.interactive,
				startedAt: ChatDates.parse(row.startedAt), completedAt: ChatDates.parse(row.completedAt),
				createdAt: ChatDates.parse(row.createdAt))
		}
	}

	private static func state(_ raw: String) -> AgentStatus { AgentStatus(rawValue: raw) ?? .idle }

	static func json(_ container: (any Encodable)?) -> JSONValue? {
		guard let container, let data = try? JSONEncoder().encode(container) else { return nil }
		return try? JSONDecoder().decode(JSONValue.self, from: data)
	}
}
