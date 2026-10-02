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
}
