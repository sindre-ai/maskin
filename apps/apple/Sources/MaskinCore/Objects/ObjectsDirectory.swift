import Foundation
import Observation

/// Resolves ids to names and holds the workspace's object schema, so no screen ever renders a raw
/// id as a label. Loaded once per workspace and shared by the list and every detail screen.
@MainActor
@Observable
public final class ObjectsDirectory {
	public private(set) var actors: [String: ActorRef] = [:]
	public private(set) var schema: ObjectsSchema = .fallback

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private let workspaceId: @MainActor () -> String?
	@ObservationIgnored private var loadedFor: String?

	public init(remote: any ObjectsRemote, workspaceId: @escaping @MainActor () -> String?) {
		self.remote = remote
		self.workspaceId = workspaceId
	}

	/// Preloaded, for previews and snapshot tests.
	public init(
		remote: any ObjectsRemote, actors: [ActorRef], schema: ObjectsSchema = .fallback
	) {
		self.remote = remote
		self.workspaceId = { nil }
		self.actors = Dictionary(uniqueKeysWithValues: actors.map { ($0.id, $0) })
		self.schema = schema
		loadedFor = "preset"
	}

	/// Loads actors and schema once per workspace; failures keep whatever is already there.
	public func load(force: Bool = false) async {
		let workspace = workspaceId()
		if !force, loadedFor != nil, loadedFor == workspace || workspace == nil { return }
		async let people = try? remote.actors()
		async let settings: ObjectsSchema? = {
			guard let workspace else { return nil }
			return try? await remote.schema(workspaceId: workspace)
		}()
		let (loadedActors, loadedSchema) = await (people, settings)
		if let loadedActors { actors = Dictionary(loadedActors.map { ($0.id, $0) }, uniquingKeysWith: { $1 }) }
		if let loadedSchema { schema = loadedSchema }
		if loadedActors != nil || loadedSchema != nil { loadedFor = workspace }
	}

	public func actor(for id: String?) -> ActorRef? {
		guard let id else { return nil }
		return actors[id]
	}

	/// The actor's name, or `nil` when it can't be resolved (callers say "Someone", never the id).
	public func name(for id: String?) -> String? { actor(for: id)?.name }

	public func typeName(_ type: String) -> String { schema.displayName(for: type) }
}
