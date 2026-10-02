import Foundation
import MaskinAPI

@testable import MaskinCore

let agentT0 = Date(timeIntervalSince1970: 1_790_000_000)

func agentRow(
	_ id: String, name: String? = nil, description: String? = nil, state: AgentStatus = .idle,
	system: Bool = false
) -> AgentSummary {
	AgentSummary(
		id: id, name: name ?? id.capitalized, description: description, isSystem: system,
		storedState: state)
}

func agentSession(
	_ id: String, actor: String, status: String = "completed", at offset: TimeInterval = 0,
	prompt: String = "Do the thing", activity: String? = nil
) -> AgentSession {
	AgentSession(
		id: id, actorID: actor, status: status, prompt: prompt, currentActivity: activity,
		startedAt: agentT0.addingTimeInterval(offset), createdAt: agentT0.addingTimeInterval(offset))
}

actor FakeAgentsAPI: AgentsAPI {
	var rows: [AgentSummary]
	var sessionRows: [AgentSession]
	var failing = false
	var calls = 0
	var latest: [String: AgentSession] = [:]
	private(set) var latestCalls: [String] = []

	init(_ rows: [AgentSummary] = [], sessions: [AgentSession] = []) {
		self.rows = rows
		self.sessionRows = sessions
	}

	func set(_ rows: [AgentSummary]) { self.rows = rows }
	func set(sessions: [AgentSession]) { sessionRows = sessions }
	func setFailing(_ f: Bool) { failing = f }
	func set(latest: [String: AgentSession]) { self.latest = latest }

	func latestSession(agentID: String) async throws -> AgentSession? {
		latestCalls.append(agentID)
		return latest[agentID]
	}

	func agents() async throws -> [AgentSummary] {
		calls += 1
		if failing { throw AgentsError("offline") }
		return rows
	}

	func recentSessions(limit: Int) async throws -> [AgentSession] {
		if failing { throw AgentsError("offline") }
		return sessionRows
	}
}

/// Server-side single agent. Actions mutate `profileValue` / `sessionRows` like the real API.
actor FakeAgentDetailAPI: AgentDetailAPI {
	var profileValue: AgentProfile
	var sessionRows: [AgentSession]
	var failNext: String?
	var runPrompts: [String?] = []
	var pauseCalls = 0
	var resetCalls = 0
	var stopped: [String] = []
	var delay: Duration?
	/// Throw after applying a write, like a response lost on the wire.
	var dropNextResponse = false
	private(set) var keys: [String] = []

	init(_ profile: AgentProfile, sessions: [AgentSession] = []) {
		self.profileValue = profile
		self.sessionRows = sessions
	}

	func fail(next message: String?) { failNext = message }
	func setDelay(_ d: Duration?) { delay = d }
	func setDropNextResponse(_ v: Bool) { dropNextResponse = v }
	private func lose() throws {
		if dropNextResponse {
			dropNextResponse = false
			throw AgentsError("offline")
		}
	}
	func set(profile: AgentProfile) { profileValue = profile }
	func set(sessions: [AgentSession]) { sessionRows = sessions }

	private func check() throws {
		if let message = failNext {
			failNext = nil
			throw AgentsError(message)
		}
	}

	func profile(agentID: String) async throws -> AgentProfile { profileValue }
	func sessions(agentID: String, limit: Int) async throws -> [AgentSession] { sessionRows }

	func run(agentID: String, prompt: String?, idempotencyKey: String) async throws -> AgentStatus {
		if let delay { try await Task.sleep(for: delay) }
		try check()
		keys.append(idempotencyKey)
		runPrompts.append(prompt)
		profileValue.storedState = .running
		sessionRows.insert(agentSession("new", actor: agentID, status: "running", at: 100), at: 0)
		try lose()
		return .running
	}

	func pause(agentID: String, idempotencyKey: String) async throws -> AgentStatus {
		if let delay { try await Task.sleep(for: delay) }
		try check()
		keys.append(idempotencyKey)
		pauseCalls += 1
		profileValue.storedState = .paused
		for i in sessionRows.indices where sessionRows[i].isActive { sessionRows[i].status = "paused" }
		return .paused
	}

	func reset(agentID: String, idempotencyKey: String) async throws -> AgentStatus {
		try check()
		keys.append(idempotencyKey)
		resetCalls += 1
		profileValue.storedState = .idle
		return .idle
	}

	func stop(sessionID: String, idempotencyKey: String) async throws {
		try check()
		keys.append(idempotencyKey)
		stopped.append(sessionID)
		if let i = sessionRows.firstIndex(where: { $0.id == sessionID }) { sessionRows[i].status = "stopped" }
	}
}

func agentProfile(
	_ id: String = "forge", state: AgentStatus = .idle, system: Bool = false
) -> AgentProfile {
	AgentProfile(
		id: id, name: id.capitalized, description: "Ships fixes\nSecond line", systemPrompt: "You fix bugs.",
		llmProvider: "claude", tools: [AgentTool(name: "github", kind: "http")], skills: ["triage"],
		isSystem: system, storedState: state)
}
