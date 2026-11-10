import Foundation
import MaskinAPI

/// Sends one share, resumably. The same `SharePoster` instance serves a Retry: it remembers what
/// already reached the server (the object, each uploaded file, each attachment edge) and every
/// request carries an Idempotency-Key derived from one stable base, so a retry after a lost
/// response never creates a second object or a second copy of a file.
public actor SharePoster {
	public struct Progress: Sendable, Equatable {
		public var objectID: String?
		public var fileIDs: [UUID: String] = [:]
		public var attached: Set<UUID> = []
		public var messageSent = false
		/// The chat a new-chat share created.
		public var chatID: String?
	}

	public enum Step: Sendable, Equatable {
		case creatingObject
		case sendingMessage
		case startingChat
		case uploading(index: Int, of: Int)
	}

	public struct Outcome: Sendable, Equatable {
		public var objectID: String?
		public var objectType: String?
		public var conversationID: String?
		public var fileIDs: [String]

		public init(
			objectID: String? = nil, objectType: String? = nil, conversationID: String? = nil,
			fileIDs: [String] = []
		) {
			self.objectID = objectID
			self.objectType = objectType
			self.conversationID = conversationID
			self.fileIDs = fileIDs
		}
	}

	private let remote: any ShareRemote
	private let base: String
	/// The stable base of every Idempotency-Key this share sends. A queued share keeps it, so
	/// the app finishing the job later can never duplicate what the extension already created.
	public nonisolated var idempotencyBase: String { base }
	public private(set) var progress = Progress()

	public init(remote: any ShareRemote, idempotencyBase: String = IdempotencyKey.make()) {
		self.remote = remote
		self.base = idempotencyBase
	}

	/// Throws the first failure and keeps `progress`; call again with the same request to resume.
	public func post(_ request: ShareRequest, onStep: @Sendable (Step) -> Void = { _ in }) async throws -> Outcome {
		let attachments = request.content.attachments
		switch request.destination {
		case .object(let type):
			if progress.objectID == nil {
				onStep(.creatingObject)
				progress.objectID = try await remote.createObject(
					type: type, title: ShareComposer.objectTitle(request.title, content: request.content),
					content: ShareComposer.objectContent(note: request.note, content: request.content),
					status: request.status, idempotencyKey: "\(base)-object")
			}
			guard let objectID = progress.objectID else { throw ShareError.unknown }
			for (index, attachment) in attachments.enumerated() {
				onStep(.uploading(index: index + 1, of: attachments.count))
				let fileID = try await upload(attachment)
				if !progress.attached.contains(attachment.id) {
					try await remote.attach(
						fileID: fileID, toObject: objectID, objectType: type,
						idempotencyKey: "\(base)-attach-\(attachment.id.uuidString)")
					progress.attached.insert(attachment.id)
				}
			}
			return Outcome(objectID: objectID, objectType: type, fileIDs: attachments.compactMap { progress.fileIDs[$0.id] })
		case .chat(let conversationID):
			var refs: [ChatAttachmentRef] = []
			for (index, attachment) in attachments.enumerated() {
				onStep(.uploading(index: index + 1, of: attachments.count))
				let fileID = try await upload(attachment)
				refs.append(
					ChatAttachmentRef(
						fileID: fileID, name: attachment.name, mimeType: attachment.mimeType,
						sizeBytes: attachment.sizeBytes))
			}
			if !progress.messageSent {
				onStep(.sendingMessage)
				try await remote.sendChatMessage(
					conversationID: conversationID,
					content: ShareComposer.chatMessage(note: request.note, content: request.content),
					attachments: refs, idempotencyKey: "\(base)-message")
				progress.messageSent = true
			}
			return Outcome(conversationID: conversationID, fileIDs: refs.map(\.fileID))
		case .newChat(let agentID):
			var refs: [ChatAttachmentRef] = []
			for (index, attachment) in attachments.enumerated() {
				onStep(.uploading(index: index + 1, of: attachments.count))
				let fileID = try await upload(attachment)
				refs.append(
					ChatAttachmentRef(
						fileID: fileID, name: attachment.name, mimeType: attachment.mimeType,
						sizeBytes: attachment.sizeBytes))
			}
			// The chat and its first message go out in one request, under their own key, so a
			// retry can never start a second chat or leave an empty one.
			if progress.chatID == nil {
				onStep(.startingChat)
				progress.chatID = try await remote.createChat(
					agentID: agentID, title: ShareComposer.chatTitle(request.title, content: request.content),
					content: ShareComposer.chatMessage(note: request.note, content: request.content),
					attachments: refs, idempotencyKey: Self.chatKey(base: base))
			}
			return Outcome(conversationID: progress.chatID, fileIDs: refs.map(\.fileID))
		case .filesOnly:
			guard !attachments.isEmpty else { throw ShareError.nothingToShare }
			for (index, attachment) in attachments.enumerated() {
				onStep(.uploading(index: index + 1, of: attachments.count))
				_ = try await upload(attachment)
			}
			return Outcome(fileIDs: attachments.compactMap { progress.fileIDs[$0.id] })
		}
	}

	/// The Idempotency-Key of the create-chat call. A chat started from a share is counted by the
	/// `started_from` mark on its first message (`APIShareRemote.createChat`); the prefix only tells
	/// its key apart from the file and message keys.
	static func chatKey(base: String) -> String { "\(chatKeyPrefix)\(base)" }
	static let chatKeyPrefix = "share-chat-"

	private func upload(_ attachment: ShareAttachment) async throws -> String {
		if let existing = progress.fileIDs[attachment.id] { return existing }
		let id = try await remote.uploadFile(
			name: attachment.name, mimeType: attachment.mimeType, fileURL: attachment.fileURL,
			idempotencyKey: "\(base)-file-\(attachment.id.uuidString)")
		progress.fileIDs[attachment.id] = id
		return id
	}
}
