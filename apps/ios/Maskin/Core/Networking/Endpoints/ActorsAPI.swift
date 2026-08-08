import Foundation

/// Mirrors `api.actors.*` — used to resolve names/types for avatars in comment threads
/// and chat rows where only an `actorId` is available.
enum ActorsAPI {
	static func list(workspaceId: String) async throws -> [Actor] {
		try await APIClient.shared.request("actors", workspaceId: workspaceId)
	}
}
