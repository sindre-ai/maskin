import Foundation

/// Mirrors `api.events.*` — comment history and the `create_comment` write path used by
/// both the composer and the Approve/Hold/chip actions (see plan §5).
enum EventsAPI {
	static func history(entityType: String, entityId: String, action: String? = nil, workspaceId: String) async throws -> [CommentEvent] {
		try await APIClient.shared.request(
			"events/history",
			query: ["entity_type": entityType, "entity_id": entityId, "action": action],
			workspaceId: workspaceId
		)
	}

	private struct CreateCommentBody: Encodable {
		let entity_id: String
		let content: String
		let parent_event_id: Int?
	}

	@discardableResult
	static func createComment(entityId: String, content: String, parentEventId: Int? = nil, workspaceId: String) async throws -> CommentEvent {
		try await APIClient.shared.request(
			"events", method: .post,
			body: CreateCommentBody(entity_id: entityId, content: content, parent_event_id: parentEventId),
			workspaceId: workspaceId
		)
	}
}
