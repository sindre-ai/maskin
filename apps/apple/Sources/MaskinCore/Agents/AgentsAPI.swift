import Foundation

/// Agents list endpoints. A protocol so `AgentsStore` tests without a server.
public protocol AgentsAPI: Sendable {
	/// Agent actors only (humans filtered out), with their stored state.
	func agents() async throws -> [AgentSummary]
	/// Recent sessions across the workspace, newest first.
	func recentSessions(limit: Int) async throws -> [AgentSession]
	/// The newest session of one agent, for agents that have none in the workspace-wide window.
	func latestSession(agentID: String) async throws -> AgentSession?
	/// `POST /api/actors` (type agent) then add it to this workspace. Returns the new row.
	func create(draft: AgentDraft, idempotencyKey: String) async throws -> AgentSummary
}

extension AgentsAPI {
	public func latestSession(agentID: String) async throws -> AgentSession? { nil }
	public func create(draft: AgentDraft, idempotencyKey: String) async throws -> AgentSummary {
		throw AgentsError("Creating agents isn't available here.")
	}
}

/// Everything one agent's screen needs.
public protocol AgentDetailAPI: Sendable {
	func profile(agentID: String) async throws -> AgentProfile
	/// Recent sessions for one agent, newest first.
	func sessions(agentID: String, limit: Int) async throws -> [AgentSession]
	/// `POST /api/actors/{id}/run`. Starts a fresh session with `prompt`, or resumes a paused one.
	func run(agentID: String, prompt: String?, idempotencyKey: String) async throws -> AgentStatus
	/// `POST /api/actors/{id}/pause`.
	func pause(agentID: String, idempotencyKey: String) async throws -> AgentStatus
	/// `POST /api/actors/{id}/reset` — system agents only.
	func reset(agentID: String, idempotencyKey: String) async throws -> AgentStatus
	func stop(sessionID: String, idempotencyKey: String) async throws
	/// `PATCH /api/actors/{id}` with only the changed fields. Returns the saved profile.
	func update(agentID: String, edit: AgentEdit, idempotencyKey: String) async throws -> AgentProfile
	/// `DELETE /api/actors/{id}` (agents only).
	func delete(agentID: String, idempotencyKey: String) async throws
}

extension AgentDetailAPI {
	public func update(agentID: String, edit: AgentEdit, idempotencyKey: String) async throws
		-> AgentProfile
	{
		throw AgentsError("Editing agents isn't available here.")
	}
	public func delete(agentID: String, idempotencyKey: String) async throws {
		throw AgentsError("Deleting agents isn't available here.")
	}
}
