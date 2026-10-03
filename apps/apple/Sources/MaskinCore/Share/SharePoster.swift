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
	}

	public enum Step: Sendable, Equatable {
		case creatingObject
		case uploading(index: Int, of: Int)
	}

	public struct Outcome: Sendable, Equatable {
		public var objectID: String?
		public var objectType: String?
		public var fileIDs: [String]
	}

	private let remote: any ShareRemote
	private let base: String
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
		case .filesOnly:
			guard !attachments.isEmpty else { throw ShareError.nothingToShare }
			for (index, attachment) in attachments.enumerated() {
				onStep(.uploading(index: index + 1, of: attachments.count))
				_ = try await upload(attachment)
			}
			return Outcome(objectID: nil, objectType: nil, fileIDs: attachments.compactMap { progress.fileIDs[$0.id] })
		}
	}

	private func upload(_ attachment: ShareAttachment) async throws -> String {
		if let existing = progress.fileIDs[attachment.id] { return existing }
		let id = try await remote.uploadFile(
			name: attachment.name, mimeType: attachment.mimeType, fileURL: attachment.fileURL,
			idempotencyKey: "\(base)-file-\(attachment.id.uuidString)")
		progress.fileIDs[attachment.id] = id
		return id
	}
}
