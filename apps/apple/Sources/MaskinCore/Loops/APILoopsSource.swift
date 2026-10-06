import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production source for the loop stores. The generated client's operation names stay inside this
/// file; the stores see `LoopsAPI` and plain models.
public struct APILoopsSource: LoopsAPI {
	private let client: Client
	private let workspaceID: String
	private let objects: (any ObjectsRemote)?
	private let files: (any FilesRemote)?

	/// `objects` supplies the loop's graph (members, posts, files); without it the loop page
	/// shows the step spine and activity only.
	/// `files` looks up what the loop produced, so only real outcomes (pages, PDFs) are listed.
	public init(
		client: Client, workspaceID: String, objects: (any ObjectsRemote)? = nil,
		files: (any FilesRemote)? = nil
	) {
		self.client = client
		self.workspaceID = workspaceID
		self.objects = objects
		self.files = files
	}

	public func overview(loopID: String) async throws -> LoopOverview {
		guard let objects else { return .empty }
		let graph = try await objects.graph(objectId: loopID)
		let members = LoopOverviewBuilder.members(from: graph)
		let loopFiles = LoopOverviewBuilder.files(from: graph, sourceTitle: nil)
		let sample = Array(members.prefix(LoopOverviewBuilder.memberFileLookups))
		let memberFiles = await withTaskGroup(of: [LoopOutput].self) { group in
			for member in sample {
				group.addTask {
					guard let g = try? await objects.graph(objectId: member.id) else { return [] }
					return LoopOverviewBuilder.files(from: g, sourceTitle: member.title)
				}
			}
			var all: [LoopOutput] = []
			for await files in group { all += files }
			return all
		}
		let order: [String]
		if let type = LoopPhases.primaryType(of: members),
			let schema = try? await objects.schema(workspaceId: workspaceID)
		{
			order = schema.statuses(for: type)
		} else {
			order = []
		}
		let produced = LoopOverviewBuilder.outputs(loopFiles: loopFiles, memberFiles: memberFiles)
		let rows = produced.isEmpty ? [] : try? await files?.summaries(ids: produced.map(\.id))
		let metadata = rows.map { Dictionary($0.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
		return LoopOverview(
			members: members, posts: LoopOverviewBuilder.posts(from: graph.events),
			outputs: LoopOverviewBuilder.outcomes(from: produced, files: metadata),
			statusOrder: order)
	}

	public func digestSource(loopID: String) async throws -> LoopOverview {
		guard let objects else { return .empty }
		let graph = try await objects.graph(objectId: loopID)
		let members = LoopOverviewBuilder.members(from: graph)
		var order: [String] = []
		if let type = LoopPhases.primaryType(of: members),
			let schema = try? await objects.schema(workspaceId: workspaceID)
		{
			order = schema.statuses(for: type)
		}
		return LoopOverview(
			members: members, posts: LoopOverviewBuilder.posts(from: graph.events), outputs: [],
			statusOrder: order)
	}

	public func loops() async throws -> [LoopSummary] {
		let output = try await client.get_sol_api_sol_loops(
			.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw AutomationError("Couldn't load loops.") }
		return try Self.decode(LoopsWire.self, from: ok.body.json).loops.map(\.model)
	}

	public func steps(loopID: String) async throws -> [LoopStep] {
		let output = try await client.get_sol_api_sol_loops_sol__lcub_id_rcub__sol_steps(
			.init(
				path: .init(id: loopID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw AutomationError("Couldn't load this loop's steps.") }
		return try Self.decode(StepsWire.self, from: ok.body.json).steps.map(\.model)
	}

	public func activity(loopID: String) async throws -> [LoopActivityEntry] {
		let output = try await client.get_sol_api_sol_loops_sol__lcub_id_rcub__sol_activity(
			.init(
				path: .init(id: loopID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else {
			throw AutomationError("Couldn't load this loop's activity.")
		}
		return try Self.decode(ActivityWire.self, from: ok.body.json).events.map(\.model)
	}

	public func actors() async throws -> [AutomationActor] {
		try await AutomationActorsSource.load(client: client, workspaceID: workspaceID)
	}

	public func installs() async throws -> [LoopInstall] {
		let output = try await client.get_sol_api_sol_installed_hyphen_loops(
			.init(query: .init(workspaceId: workspaceID)))
		guard case .ok(let ok) = output else { throw AutomationError("Couldn't load installed loops.") }
		return try Self.decode(InstallsWire.self, from: ok.body.json).installs.map {
			LoopInstall(
				objectID: $0.objectId, hasUpdate: $0.hasUpdate, availableVersion: $0.availableVersion,
				isForked: $0.forkedAt != nil)
		}
	}

	public func setStatus(loopID: String, status: LoopPill, idempotencyKey: String) async throws {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.patch_sol_api_sol_objects_sol__lcub_id_rcub_(
				.init(
					path: .init(id: loopID),
					body: .json(.init(status: status.rawValue))))
		}
		switch output {
		case .ok: return
		case .notFound: throw AutomationError("This loop no longer exists.")
		default: throw AutomationError("The server refused the change.")
		}
	}

	public func createLoop(name: String, content: String, idempotencyKey: String) async throws
		-> String
	{
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_objects(
				.init(
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(
						.init(
							_type: "loop", title: name, content: content.isEmpty ? nil : content,
							status: LoopPill.learning.rawValue))))
		}
		guard case .created(let created) = output else {
			throw AutomationError("Couldn't create the loop.")
		}
		return try created.body.json.id
	}

	public func updateLoop(loopID: String, name: String?, content: String?, idempotencyKey: String)
		async throws
	{
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.patch_sol_api_sol_objects_sol__lcub_id_rcub_(
				.init(path: .init(id: loopID), body: .json(.init(title: name, content: content))))
		}
		switch output {
		case .ok: return
		case .notFound: throw AutomationError("This loop no longer exists.")
		default: throw AutomationError("The server refused the change.")
		}
	}

	public func deleteLoop(loopID: String) async throws {
		let output = try await client.delete_sol_api_sol_objects_sol__lcub_id_rcub_(
			.init(path: .init(id: loopID)))
		switch output {
		case .ok: return
		case .notFound: throw AutomationError("This loop no longer exists.")
		default: throw AutomationError("Couldn't delete the loop.")
		}
	}

	// MARK: Wire

	private struct LoopsWire: Decodable { var loops: [LoopWire] }
	private struct StepsWire: Decodable { var steps: [StepWire] }
	private struct ActivityWire: Decodable { var events: [EventWire] }
	private struct InstallsWire: Decodable {
		struct Row: Decodable {
			var objectId: String?
			var hasUpdate: Bool
			var availableVersion: String
			var forkedAt: String?
		}
		var installs: [Row]
	}

	private struct LoopWire: Decodable {
		var id: String
		var name: String?
		var content: String?
		var status: String
		var pill: String
		var entryCondition: String?
		var closeCondition: String?
		var inProgressCount: Int
		var closedCount: Int
		var medianTimeToCloseMs: Double?
		var agentIds: [String]
		var triggerIds: [String]
		var waitingCount: Int
		var createdAt: String?
		var updatedAt: String?

		var model: LoopSummary {
			LoopSummary(
				id: id, name: name, content: content, status: LoopPill(wire: status),
				pill: LoopPill(wire: pill), entryCondition: entryCondition,
				closeCondition: closeCondition, inProgressCount: inProgressCount,
				closedCount: closedCount, medianTimeToClose: medianTimeToCloseMs.map { $0 / 1000 },
				agentIDs: agentIds, triggerIDs: triggerIds, waitingCount: waitingCount,
				createdAt: AutomationDates.parse(createdAt), updatedAt: AutomationDates.parse(updatedAt))
		}
	}

	private struct ActorRef: Decodable {
		var id: String
		var name: String?
	}

	private struct StepWire: Decodable {
		var triggerId: String
		var triggerName: String?
		var triggerActionPrompt: String?
		var triggerType: String?
		var triggerConfig: JSONValue?
		var agent: ActorRef?
		var handsOffToActor: ActorRef?
		var escalatesToActor: ActorRef?
		var pendingCount: Int?
		var escalateAfterMs: Double?

		var model: LoopStep {
			LoopStep(
				triggerID: triggerId, name: triggerName, actionPrompt: triggerActionPrompt,
				triggerKind: Trigger.Kind(wire: triggerType ?? ""),
				triggerConfig: triggerConfig ?? .object([:]), agentName: agent?.name,
				agentID: agent?.id, handsOffName: handsOffToActor?.name,
				escalatesToName: escalatesToActor?.name, escalateAfter: escalateAfterMs.map { $0 / 1000 },
				pendingCount: pendingCount ?? 0)
		}
	}

	private struct EventWire: Decodable {
		var id: Double
		var actorId: String?
		var action: String
		var entityType: String
		var description: String?
		var createdAt: String?

		var model: LoopActivityEntry {
			LoopActivityEntry(
				id: String(Int(id)), action: action, entityType: entityType, actorID: actorId,
				description: description, createdAt: AutomationDates.parse(createdAt))
		}
	}

	private static func decode<T: Decodable>(_ type: T.Type, from value: some Encodable) throws -> T {
		try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
	}
}
