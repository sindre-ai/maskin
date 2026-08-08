import Foundation

/// Mirrors `api.objects.*` in `apps/web/src/lib/api.ts`.
enum ObjectsAPI {
	struct Graph: Decodable {
		let object: MaskinObject
		let relationships: [Relationship]
		let connectedObjects: [MaskinObject]
		let events: [CommentEvent]
	}

	struct Relationship: Decodable, Identifiable {
		let id: String
		let sourceId: String
		let targetId: String
		let type: String
	}

	static func list(type: String? = nil, status: String? = nil, workspaceId: String) async throws -> [MaskinObject] {
		try await APIClient.shared.request(
			"objects",
			query: ["type": type, "status": status],
			workspaceId: workspaceId
		)
	}

	static func get(id: String, workspaceId: String) async throws -> MaskinObject {
		try await APIClient.shared.request("objects/\(id)", workspaceId: workspaceId)
	}

	static func graph(id: String, workspaceId: String) async throws -> Graph {
		try await APIClient.shared.request("objects/\(id)/graph", workspaceId: workspaceId)
	}

	static func search(query: String, workspaceId: String) async throws -> [MaskinObject] {
		try await APIClient.shared.request("objects/search", query: ["q": query], workspaceId: workspaceId)
	}

	struct CreateBody: Encodable {
		let type: String
		let title: String?
		let content: String?
		let status: String
		let metadata: [String: JSONValue]?
	}

	@discardableResult
	static func create(_ body: CreateBody, workspaceId: String) async throws -> MaskinObject {
		try await APIClient.shared.request("objects", method: .post, body: body, workspaceId: workspaceId)
	}
}
