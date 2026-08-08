import Foundation

/// Mirrors `GET /api/loops` — list-only (see plan Context: no detail endpoint exists
/// yet). Loop detail falls back to `ObjectsAPI.graph(id:)` on the loop's own object id.
enum LoopsAPI {
	struct ListResponse: Decodable { let loops: [LoopSummary] }

	static func list(workspaceId: String) async throws -> [LoopSummary] {
		let response: ListResponse = try await APIClient.shared.request("loops", workspaceId: workspaceId)
		return response.loops
	}
}
