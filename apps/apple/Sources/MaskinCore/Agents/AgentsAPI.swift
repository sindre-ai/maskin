import Foundation

/// Agents list endpoints. A protocol so `AgentsStore` tests without a server.
public protocol AgentsAPI: Sendable {
	/// Agent actors only (humans filtered out), with their stored state.
	func agents() async throws -> [AgentSummary]
	/// Recent sessions across the workspace, newest first.
	func recentSessions(limit: Int) async throws -> [AgentSession]
	/// The newest session of one agent, for agents that have none in the workspace-wide window.
	func latestSession(agentID: String) async throws -> AgentSession?
}

extension AgentsAPI {
	public func latestSession(agentID: String) async throws -> AgentSession? { nil }
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
}
