import Foundation

/// What chat caches on disk, and nothing more. Message text is sensitive, so the snapshot is an
/// explicit allow-list: only the newest page of a thread, only confirmed rows, only the metadata
/// keys the UI renders, never attachment bytes (the metadata holds file ids and names). Scoped
/// per actor and workspace by `SnapshotCache`, wiped by `DiskCache.clearAll()` on sign-out.
enum ChatCaching {
	/// Bump when any cached type below changes shape: a mismatch discards the entry.
	static let version = 1
	static let threadMessageLimit = 50
	static let listLimit = 50

	static func threadName(_ conversationID: String) -> String { "chat.\(conversationID)" }
	static let listName = "chats.list"

	/// Metadata keys a bubble renders. Everything else (stream envelopes, hashes) is dropped.
	private static let keptMetadataKeys: Set<String> = [
		"attachments", "mentions", "question", "question_answer",
	]

	struct ThreadSnapshot: Codable, Sendable {
		var detail: ConversationSummary
		var messages: [CachedMessage]
	}

	struct ListSnapshot: Codable, Sendable {
		var conversations: [ConversationSummary]
	}

	struct CachedMessage: Codable, Sendable {
		var serverID: Int
		var conversationID: String
		var actorID: String
		var actorName: String
		var author: ChatParticipant.Kind
		var kind: String
		var content: String
		var createdAt: Date?
		var editedAt: Date?
		var metadata: JSONValue?
		var isError: Bool

		init?(_ message: ChatMessage) {
			guard let id = message.serverID else { return nil }
			serverID = id
			conversationID = message.conversationID
			actorID = message.actorID
			actorName = message.actorName
			author = message.author
			kind = message.kind
			content = message.content
			createdAt = message.createdAt
			editedAt = message.editedAt
			isError = message.isErrorReply
			metadata = Self.sanitize(message.metadata)
		}

		var message: ChatMessage {
			var meta = metadata
			if isError {
				var object: [String: JSONValue] = [:]
				if case .object(let existing)? = meta { object = existing }
				object["final_output"] = .object(["is_error": .bool(true)])
				meta = .object(object)
			}
			return .confirmed(
				serverID: serverID, conversationID: conversationID, actorID: actorID, actorName: actorName,
				author: author, kind: kind, content: content, createdAt: createdAt, editedAt: editedAt,
				metadata: meta)
		}

		private static func sanitize(_ metadata: JSONValue?) -> JSONValue? {
			guard case .object(let object)? = metadata else { return nil }
			let kept = object.filter { ChatCaching.keptMetadataKeys.contains($0.key) }
			return kept.isEmpty ? nil : .object(kept)
		}
	}
}
