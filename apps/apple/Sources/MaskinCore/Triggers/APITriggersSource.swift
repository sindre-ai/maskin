import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production source for the trigger stores. The generated client's operation names stay inside
/// this file; the stores see `TriggersAPI` and plain models.
public struct APITriggersSource: TriggersAPI {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	/// Safety bound on paging (pages of 100). A workspace past it is reported as incomplete.
	static let maxRows = 10_000

	public func list() async throws -> [Trigger] { try await listPage().triggers }

	public func listPage() async throws -> TriggerListing {
		var all: [Trigger] = []
		var offset = 0
		let pageSize = 100
		var complete = false
		while offset < Self.maxRows {
			let output = try await client.get_sol_api_sol_triggers(
				.init(
					query: .init(limit: pageSize, offset: offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .ok(let ok) = output else { throw AutomationError("Couldn't load triggers.") }
			let page = try Self.decode([Wire].self, from: ok.body.json)
			all += page.map(\.model)
			if page.count < pageSize {
				complete = true
				break
			}
			offset += pageSize
		}
		return TriggerListing(triggers: all, isComplete: complete)
	}

	public func create(_ draft: TriggerDraft, idempotencyKey: String) async throws -> Trigger {
		let when: (type: String, config: JSONValue)
		switch draft.whenKind {
		case .schedule:
			when = ("cron", .object(["expression": .string(draft.schedule.expression)]))
		case .event:
			guard let event = draft.event else { throw AutomationError("Choose which event starts it.") }
			when = (
				"event",
				.object(["entity_type": .string(event.entityType), "action": .string(event.action)])
			)
		}
		let body: JSONValue = .object([
			"type": .string(when.type),
			"name": .string(draft.resolvedName),
			"action_prompt": .string(draft.trimmedPrompt),
			"target_actor_id": .string(draft.targetActorID ?? ""),
			"enabled": .bool(true),
			"config": when.config,
		])
		let payload = try Self.decode(
			Operations.post_sol_api_sol_triggers.Input.Body.jsonPayload.self, from: body)
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_triggers(
				.init(
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID), body: .json(payload)))
		}
		switch output {
		case .created(let created): return try Self.decode(Wire.self, from: created.body.json).model
		case .badRequest: throw AutomationError("The server rejected this trigger. Check the fields.")
		default: throw AutomationError("Couldn't create the trigger.")
		}
	}

	public func update(id: String, patch: TriggerPatch, idempotencyKey: String) async throws
		-> Trigger
	{
		var fields: [String: JSONValue] = [:]
		if let name = patch.name { fields["name"] = .string(name) }
		if let prompt = patch.actionPrompt { fields["action_prompt"] = .string(prompt) }
		if let agent = patch.targetActorID { fields["target_actor_id"] = .string(agent) }
		if let enabled = patch.enabled { fields["enabled"] = .bool(enabled) }
		if let config = patch.config, let kind = patch.kind {
			fields["config"] = config
			fields["type"] = .string(kind.rawValue)
		}
		let body: JSONValue = .object(fields)
		let payload = try Self.decode(
			Operations.patch_sol_api_sol_triggers_sol__lcub_id_rcub_.Input.Body.jsonPayload.self,
			from: body)
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.patch_sol_api_sol_triggers_sol__lcub_id_rcub_(
				.init(path: .init(id: id), body: .json(payload)))
		}
		switch output {
		case .ok(let ok): return try Self.decode(Wire.self, from: ok.body.json).model
		case .notFound: throw AutomationError("This trigger no longer exists.")
		default: throw AutomationError("Couldn't save the trigger.")
		}
	}

	public func delete(id: String, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.delete_sol_api_sol_triggers_sol__lcub_id_rcub_(.init(path: .init(id: id)))
		}
		switch output {
		case .ok: return
		default: throw AutomationError("Couldn't delete the trigger.")
		}
	}

	public func actors() async throws -> [AutomationActor] {
		try await AutomationActorsSource.load(client: client, workspaceID: workspaceID)
	}

	public func recentRuns(triggerID: String, limit: Int) async throws -> [TriggerRun] {
		let output = try await client.get_sol_api_sol_sessions(
			.init(
				query: .init(trigger_id: triggerID, limit: limit),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw AutomationError("Couldn't load recent runs.") }
		let rows = try Self.decode([RunWire].self, from: ok.body.json)
		return rows.map {
			TriggerRun(
				id: $0.id, outcome: TriggerRun.outcome(forStatus: $0.status),
				at: AutomationDates.parse($0.completedAt ?? $0.startedAt ?? $0.createdAt))
		}
	}

	// MARK: Wire

	private struct RunWire: Decodable {
		var id: String
		var status: String
		var createdAt: String?
		var startedAt: String?
		var completedAt: String?
	}

	private struct Wire: Decodable {
		var id: String
		var name: String
		var type: String
		var config: JSONValue?
		var actionPrompt: String
		var targetActorId: String
		var enabled: Bool
		var createdAt: String?
		var updatedAt: String?

		var model: Trigger {
			Trigger(
				id: id, name: name, kind: Trigger.Kind(wire: type), config: config ?? .object([:]),
				actionPrompt: actionPrompt, targetActorID: targetActorId, enabled: enabled,
				createdAt: AutomationDates.parse(createdAt), updatedAt: AutomationDates.parse(updatedAt))
		}
	}

	/// Generated types and our models only meet through JSON, so a spec change can't leak names.
	private static func decode<T: Decodable>(_ type: T.Type, from value: some Encodable) throws -> T {
		try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
	}
}

/// Workspace actors (people and agents) for name resolution; shared by the loops and triggers adapters.
enum AutomationActorsSource {
	static func load(client: Client, workspaceID: String) async throws -> [AutomationActor] {
		var all: [AutomationActor] = []
		var offset = 0
		let pageSize = 100
		while offset < 10_000 {
			let output = try await client.get_sol_api_sol_actors(
				.init(
					query: .init(limit: pageSize, offset: offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .ok(let ok) = output else {
				throw AutomationError("Couldn't load people and agents.")
			}
			let rows = try ok.body.json
			all += rows.map {
				AutomationActor(id: $0.id, name: $0.name, isAgent: $0._type == "agent", summary: $0.description)
			}
			if rows.count < pageSize { break }
			offset += pageSize
		}
		return all
	}
}
