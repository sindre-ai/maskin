import Foundation

/// Loop endpoints for one workspace. A protocol so the stores test without a server.
public protocol LoopsAPI: Sendable {
	func loops() async throws -> [LoopSummary]
	/// The ordered step spine (trigger + agent per step).
	func steps(loopID: String) async throws -> [LoopStep]
	/// Agent-work events for the loop, newest first.
	func activity(loopID: String) async throws -> [LoopActivityEntry]
	func actors() async throws -> [AutomationActor]
	/// Marketplace installs, for "update available". Best effort.
	func installs() async throws -> [LoopInstall]
	/// Sets the loop's lifecycle status (pause / resume).
	func setStatus(loopID: String, status: LoopPill, idempotencyKey: String) async throws
	/// Creates a loop object (web parity: starts on the first live rung) and returns its id.
	func createLoop(name: String, content: String, idempotencyKey: String) async throws -> String
	/// Renames and/or rewrites the loop's description. `nil` leaves a field alone.
	func updateLoop(loopID: String, name: String?, content: String?, idempotencyKey: String)
		async throws
	func deleteLoop(loopID: String) async throws
	/// Members, agent posts and produced files, from the loop's object graph. Best effort: a
	/// source with no graph access returns `.empty`.
	func overview(loopID: String) async throws -> LoopOverview
	/// The newest top-level post on the loop's timeline, for the list card's latest update. One
	/// read of the loop object's graph; nil when it has none or the source has no graph access.
	func latestPost(loopID: String) async throws -> LoopPost?
	/// The newest runs (sessions) launched from these triggers, a bounded page per trigger. Best
	/// effort: the stuck check and the health rows work without it.
	func runs(triggerIDs: [String]) async throws -> [LoopRun]
}

extension LoopsAPI {
	/// Nothing, for a source with no session access.
	public func runs(triggerIDs: [String]) async throws -> [LoopRun] { [] }
	public func overview(loopID: String) async throws -> LoopOverview { .empty }
	public func latestPost(loopID: String) async throws -> LoopPost? { nil }
}
