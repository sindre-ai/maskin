import Foundation

@testable import MaskinCore

func trig(
	_ id: String, name: String = "Trigger", kind: Trigger.Kind = .cron,
	config: JSONValue = .object(["expression": .string("0 9 * * *")]), agent: String = "agent-1",
	enabled: Bool = true, prompt: String = "Do the thing"
) -> Trigger {
	Trigger(
		id: id, name: name, kind: kind, config: config, actionPrompt: prompt, targetActorID: agent,
		enabled: enabled)
}

let testActors = [
	AutomationActor(id: "agent-1", name: "Relay", isAgent: true),
	AutomationActor(id: "agent-2", name: "Forge", isAgent: true),
	AutomationActor(id: "me", name: "Alex", isAgent: false),
]

actor FakeTriggersAPI: TriggersAPI {
	var rows: [Trigger]
	var failUpdates = false
	var failList = false
	private(set) var updates: [(String, TriggerPatch)] = []
	private(set) var created: [TriggerDraft] = []
	private(set) var deleted: [String] = []
	private(set) var listCalls = 0
	var updateDelay: Duration?
	var listComplete = true
	var deleteDelay: Duration?
	/// Throw after applying a write, like a response lost on the wire.
	var dropNextResponse = false
	private(set) var createKeys: [String] = []
	private(set) var updateKeys: [String] = []
	private(set) var deleteKeys: [String] = []

	init(_ rows: [Trigger]) { self.rows = rows }

	func set(_ rows: [Trigger]) { self.rows = rows }
	func setFailUpdates(_ value: Bool) { failUpdates = value }
	func setFailList(_ value: Bool) { failList = value }
	func setUpdateDelay(_ value: Duration?) { updateDelay = value }
	func setDeleteDelay(_ value: Duration?) { deleteDelay = value }
	func setListComplete(_ value: Bool) { listComplete = value }
	func setDropNextResponse(_ value: Bool) { dropNextResponse = value }

	func listPage() async throws -> TriggerListing {
		TriggerListing(triggers: try await list(), isComplete: listComplete)
	}

	func list() async throws -> [Trigger] {
		listCalls += 1
		if failList { throw AutomationError("offline") }
		return rows
	}

	func create(_ draft: TriggerDraft, idempotencyKey: String) async throws -> Trigger {
		created.append(draft)
		createKeys.append(idempotencyKey)
		let made = Trigger(
			id: "new-\(created.count)", name: draft.trimmedName, kind: .cron,
			config: .object(["expression": .string(draft.schedule.expression)]),
			actionPrompt: draft.trimmedPrompt, targetActorID: draft.targetActorID ?? "")
		rows.insert(made, at: 0)
		if dropNextResponse {
			dropNextResponse = false
			throw AutomationError("offline")
		}
		return made
	}

	func update(id: String, patch: TriggerPatch, idempotencyKey: String) async throws -> Trigger {
		updates.append((id, patch))
		updateKeys.append(idempotencyKey)
		if let updateDelay { try await Task.sleep(for: updateDelay) }
		if failUpdates { throw AutomationError("server said no") }
		guard let i = rows.firstIndex(where: { $0.id == id }) else { throw AutomationError("gone") }
		if let v = patch.name { rows[i].name = v }
		if let v = patch.actionPrompt { rows[i].actionPrompt = v }
		if let v = patch.targetActorID { rows[i].targetActorID = v }
		if let v = patch.enabled { rows[i].enabled = v }
		if let v = patch.config { rows[i].config = v }
		return rows[i]
	}

	func delete(id: String, idempotencyKey: String) async throws {
		deleteKeys.append(idempotencyKey)
		if let deleteDelay { try await Task.sleep(for: deleteDelay) }
		if failUpdates { throw AutomationError("server said no") }
		deleted.append(id)
		rows.removeAll { $0.id == id }
	}

	func actors() async throws -> [AutomationActor] { testActors }
}

func triggerFrame(_ id: Int, trigger: String, entity: String = "trigger") -> String {
	let json =
		#"{"workspace_id":"w1","actor_id":"a","action":"updated","entity_type":"\#(entity)","entity_id":"\#(trigger)","event_id":"\#(id)"}"#
	return "id: \(id)\nevent: updated\ndata: \(json)\n\n"
}
