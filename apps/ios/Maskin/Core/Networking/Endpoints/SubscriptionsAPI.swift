import Foundation

/// Mirrors `POST/GET /api/subscriptions/*` — the backing data for both Chats and
/// For You (see plan §5: "Screen -> API mapping").
enum SubscriptionsAPI {
	static func unread(workspaceId: String) async throws -> [UnreadItem] {
		let response: UnreadResponse = try await APIClient.shared.request(
			"subscriptions/unread", query: ["entity_type": "object"], workspaceId: workspaceId
		)
		return response.items
	}

	private struct MarkReadBody: Encodable { let entity_type: String, entity_id: String, last_event_id: Int }
	private struct MarkReadResponse: Decodable { let updated: Bool }

	static func markRead(entityId: String, lastEventId: Int, workspaceId: String) async throws {
		let _: MarkReadResponse = try await APIClient.shared.request(
			"subscriptions/read", method: .post,
			body: MarkReadBody(entity_type: "object", entity_id: entityId, last_event_id: lastEventId),
			workspaceId: workspaceId
		)
	}
}
