import Foundation

/// Trigger endpoints for one workspace. A protocol so the stores test without a server.
public protocol TriggersAPI: Sendable {
	func list() async throws -> [Trigger]
	/// The list plus whether it is known to be every trigger. A list cut short by a client-side cap
	/// must not be read as "this trigger was deleted".
	func listPage() async throws -> TriggerListing
	func create(_ draft: TriggerDraft, idempotencyKey: String) async throws -> Trigger
	func update(id: String, patch: TriggerPatch, idempotencyKey: String) async throws -> Trigger
	func delete(id: String, idempotencyKey: String) async throws
	/// Workspace people and agents, to resolve and pick the agent a trigger runs.
	func actors() async throws -> [AutomationActor]
}

public struct TriggerListing: Sendable {
	public var triggers: [Trigger]
	/// `false` when the source stopped before the end; absence from `triggers` then means unknown.
	public var isComplete: Bool
	public init(triggers: [Trigger], isComplete: Bool = true) {
		self.triggers = triggers
		self.isComplete = isComplete
	}
}

extension TriggersAPI {
	public func listPage() async throws -> TriggerListing { TriggerListing(triggers: try await list()) }
}
