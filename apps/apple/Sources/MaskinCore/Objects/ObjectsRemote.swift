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
	/// the server notifies them (and starts a session for an agent). `refs` are objects linked with
	/// `/` (`metadata.refs`); `attachmentFileIds` are files already uploaded. Returns the stored event.
	func postComment(
		objectId: String, content: String, mentions: [String], refs: [String],
		attachmentFileIds: [String], parentEventId: Int?, idempotencyKey: String
	) async throws -> ObjectEvent
	/// `POST /api/relationships`: links `sourceId` → `targetId` with `type` (`informs`, `blocks`…).
	/// Returns the new edge as seen from the source. `idempotencyKey` stays the same across retries.
	func createRelationship(
		sourceId: String, sourceType: String, targetId: String, targetType: String, type: String,
		idempotencyKey: String
	) async throws -> ObjectLink
	/// `GET /api/actors`.
	func actors() async throws -> [ActorRef]
	/// `GET /api/objects/board`: one column per status of `query.type`, each with its first objects.
	func board(_ query: ObjectsBoardQuery) async throws -> [ObjectsBoardColumn]
	/// Workspace settings (`GET /api/workspaces`, the selected workspace's `settings`).
	func schema(workspaceId: String) async throws -> ObjectsSchema
}

extension ObjectsRemote {
	public func board(_ query: ObjectsBoardQuery) async throws -> [ObjectsBoardColumn] {
		throw ObjectsError("The board isn't available.")
	}
}

// MARK: - Drafts

/// An object as `GET /api/objects/{id}` returns it: the object itself, the workspace it belongs to
/// (a link can point into another one) and, for a draft an integration can deliver, the `preview`.
public struct ObjectDetail: Sendable, Equatable {
	public var object: WorkObject
	public var workspaceId: String
	public var preview: ObjectPreview?

	public init(object: WorkObject, workspaceId: String, preview: ObjectPreview? = nil) {
		self.object = object
		self.workspaceId = workspaceId
		self.preview = preview
	}
}

/// Why an approval did not go through, in the words a person needs.
public enum ObjectApprovalError: Error, Equatable, Sendable {
	/// 409: the draft changed since it was shown. The card re-reads it.
	case changed
	/// 400: a required field is empty; the server says which.
	case incomplete(String?)
	/// 403: only people approve.
	case notAllowed
	/// 404: the draft is gone, or not in this workspace.
	case notFound
	case offline
	case other(String)

	public var message: String {
		switch self {
		case .changed: "This draft changed since you opened it. Read it again before approving."
		case .incomplete(let detail): detail ?? "Something the draft needs is still missing."
		case .notAllowed: "Only people can approve a draft."
		case .notFound: "This draft isn't there any more."
		case .offline: "You're offline."
		case .other(let text): text
		}
	}
}

/// The two calls a draft card makes on an object. Kept apart from `ObjectsRemote` so the card's
/// logic tests against a two-method fake.
public protocol ObjectDraftsRemote: Sendable {
	/// `GET /api/objects/{id}`, with the draft `preview` when the object has one.
	func detail(objectId: String) async throws -> ObjectDetail
	/// `POST /api/objects/{id}/approval`: a person's yes to the draft exactly as the preview shows
	/// it. Returns the preview as it reads now (delivery `approved`). Throws `ObjectApprovalError`.
	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview
}
