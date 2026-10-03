import Foundation

/// Everything the Objects stores need from the server. The production implementation wraps the
/// generated client (`APIObjectsRemote`); tests supply a fake.
public protocol ObjectsRemote: Sendable {
	/// `GET /api/objects`, or `GET /api/objects/search` when `query.search` is non-empty.
	func list(_ query: ObjectsQuery) async throws -> [WorkObject]
	/// `GET /api/objects/{id}/graph`.
	func graph(objectId: String) async throws -> ObjectGraph
	/// `POST /api/objects`. `idempotencyKey` stays the same across retries of one create.
	func create(_ draft: ObjectDraft, idempotencyKey: String) async throws -> WorkObject
	/// `PATCH /api/objects/{id}`.
	func update(objectId: String, patch: ObjectPatch, idempotencyKey: String) async throws -> WorkObject
	/// `DELETE /api/objects/{id}`.
	func delete(objectId: String) async throws
	/// `POST` / `DELETE /api/objects/{id}/star`.
	func setStarred(objectId: String, starred: Bool) async throws
	/// `POST /api/events`: a comment on an object. `mentions` are the actor ids tagged with `@`;
	/// the server notifies them (and starts a session for an agent). Returns the stored event.
	func postComment(
		objectId: String, content: String, mentions: [String], parentEventId: Int?,
		idempotencyKey: String
	) async throws -> ObjectEvent
	/// `GET /api/actors`.
	func actors() async throws -> [ActorRef]
	/// Workspace settings (`GET /api/workspaces`, the selected workspace's `settings`).
	func schema(workspaceId: String) async throws -> ObjectsSchema
}
