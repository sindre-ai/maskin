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
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
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
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
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
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
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
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_sessions_sol__lcub_id_rcub__sol_stop(
				.init(
					path: .init(id: sessionID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		}
		guard case .ok = output else { throw AgentsError("Couldn't stop the session.") }
	}

	// MARK: - Mapping

	private func sessionRows(agentID: String?, limit: Int) async throws -> [AgentSession] {
		let output = try await client.get_sol_api_sol_sessions(
			.init(
				query: .init(actor_id: agentID, limit: limit),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw AgentsError("Couldn't load sessions.") }
		return try ok.body.json.map { row in
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
