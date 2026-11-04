import Foundation
import MaskinAPI
import Observation
import OpenAPIRuntime

/// Where each actor's uploaded picture lives. A protocol so `ActorPicturesStore` tests without a server.
public protocol ActorPicturesAPI: Sendable {
	/// Actor id to the path the picture is served from, for the actors that have one.
	func pictures() async throws -> [String: String]
}

/// Pictures for every person and agent in the workspace, so any avatar can look its picture up by
/// actor id. The picture addresses are public, versioned paths: no sign-in key is needed to load one.
@MainActor
@Observable
public final class ActorPicturesStore {
	public private(set) var paths: [String: String] = [:]
	@ObservationIgnored private var baseURL: URL?

	public init() {}

	/// The full address of an actor's picture, or nil when it has none.
	public func url(for actorID: String) -> URL? {
		guard let path = paths[actorID], let baseURL else { return nil }
		return URL(string: path, relativeTo: baseURL)?.absoluteURL
	}

	/// Loads the signed-in workspace's pictures; clears them when nobody is signed in.
	public func load(environment: AppEnvironment) async {
		guard let workspaceID = environment.workspaceId else {
			paths = [:]
			return
		}
		await load(
			from: APIActorPicturesSource(client: environment.client, workspaceID: workspaceID),
			baseURL: environment.baseURL)
	}

	/// A failed load keeps what is already shown; avatars fall back to initials.
	func load(from api: any ActorPicturesAPI, baseURL: URL) async {
		guard let fresh = try? await api.pictures() else { return }
		self.baseURL = baseURL
		paths = fresh
	}
}

/// Production source: the workspace actor list, which carries each actor's picture path.
struct APIActorPicturesSource: ActorPicturesAPI {
	let client: Client
	let workspaceID: String

	func pictures() async throws -> [String: String] {
		var found: [String: String] = [:]
		var offset = 0
		let pageSize = 100
		while offset < 10_000 {
			let output = try await client.get_sol_api_sol_actors(
				.init(
					query: .init(limit: pageSize, offset: offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .ok(let ok) = output else { throw AgentsError("Couldn't load pictures.") }
			let rows = try ok.body.json
			for row in rows {
				if let path = row.avatar_url, !path.isEmpty { found[row.id] = path }
			}
			if rows.count < pageSize { break }
			offset += pageSize
		}
		return found
	}
}
