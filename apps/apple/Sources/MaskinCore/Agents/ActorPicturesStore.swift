import Foundation
import MaskinAPI
import Observation
import OpenAPIRuntime

/// How the workspace's actors look, read off the actor list: where each picture lives and the
/// letters each actor chose for its avatar. Only actors that have one are in each map.
public struct ActorLooks: Sendable, Equatable {
	/// Actor id to the path the picture is served from.
	public var picturePaths: [String: String]
	/// Actor id to the letters the actor chose for its avatar.
	public var initials: [String: String]

	public init(picturePaths: [String: String] = [:], initials: [String: String] = [:]) {
		self.picturePaths = picturePaths
		self.initials = initials
	}
}

/// Where each actor's uploaded picture and chosen letters live. A protocol so `ActorPicturesStore` tests without a server.
public protocol ActorPicturesAPI: Sendable {
	func pictures() async throws -> ActorLooks
}

/// Pictures and chosen initials for every person and agent in the workspace, so any avatar can look
/// them up by actor id. The picture addresses are public, versioned paths: no sign-in key is needed to load one.
@MainActor
@Observable
public final class ActorPicturesStore {
	public private(set) var paths: [String: String] = [:]
	public private(set) var chosenInitials: [String: String] = [:]
	@ObservationIgnored private var baseURL: URL?

	public init() {}

	/// The full address of an actor's picture, or nil when it has none.
	public func url(for actorID: String) -> URL? {
		guard let path = paths[actorID], let baseURL else { return nil }
		return URL(string: path, relativeTo: baseURL)?.absoluteURL
	}

	/// The letters an actor chose for its avatar, or nil when it has set none.
	public func initials(for actorID: String) -> String? { chosenInitials[actorID] }

	/// Loads the signed-in workspace's pictures and initials; clears them when nobody is signed in.
	public func load(environment: AppEnvironment) async {
		guard let workspaceID = environment.workspaceId else {
			paths = [:]
			chosenInitials = [:]
			return
		}
		await load(
			from: APIActorPicturesSource(client: environment.client, workspaceID: workspaceID),
			baseURL: environment.baseURL)
	}

	/// A failed load keeps what is already shown; avatars fall back to the automatic initials.
	func load(from api: any ActorPicturesAPI, baseURL: URL) async {
		guard let fresh = try? await api.pictures() else { return }
		self.baseURL = baseURL
		paths = fresh.picturePaths
		chosenInitials = fresh.initials
	}
}

/// Production source: the workspace actor list, which carries each actor's picture path and chosen letters.
struct APIActorPicturesSource: ActorPicturesAPI {
	let client: Client
	let workspaceID: String

	func pictures() async throws -> ActorLooks {
		var found = ActorLooks()
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
				if let path = row.avatar_url, !path.isEmpty { found.picturePaths[row.id] = path }
				if let letters = row.initials, !letters.isEmpty { found.initials[row.id] = letters }
			}
			if rows.count < pageSize { break }
			offset += pageSize
		}
		return found
	}
}
