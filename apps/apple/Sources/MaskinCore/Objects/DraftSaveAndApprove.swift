import Foundation

/// A draft as the reader was shown it: the object that holds it and the fingerprint of the text on
/// screen. An edit is saved over this and approved against the fingerprint it produces.
public struct DraftShown: Equatable, Sendable {
	public var objectId: String
	public var contentHash: String
	public var isEmail: Bool
	/// The text and subject as shown, before any edit.
	public var text: DraftEdit

	public init(objectId: String, contentHash: String, isEmail: Bool, text: DraftEdit) {
		self.objectId = objectId
		self.contentHash = contentHash
		self.isEmail = isEmail
		self.text = text
	}

	public init(objectId: String, preview: ObjectPreview) {
		self.init(
			objectId: objectId, contentHash: preview.contentHash, isEmail: preview.kind == "email",
			text: DraftEdit(preview: preview))
	}

	public init(_ draft: ReviewDraft) {
		self.init(
			objectId: draft.objectId, contentHash: draft.contentHash, isEmail: draft.isEmail,
			text: DraftEdit(draft))
	}
}

extension DraftEdit {
	/// The edit of an untouched draft, read from its preview. Only an email has a subject to edit.
	public init(preview: ObjectPreview) {
		self.init(body: preview.body, subject: preview.kind == "email" ? (preview.subject ?? "") : nil)
	}

	public func differs(from shown: DraftShown) -> Bool { self != shown.text }

	/// There is text to send, and a subject too when it is an email.
	public func isApprovable(isEmail: Bool) -> Bool {
		!body.trimmed.isEmpty && (!isEmail || !(subject ?? "").trimmed.isEmpty)
	}

	/// Why Approve is off, as one line for the card; nil when it is available. The same words as
	/// the For you card.
	public func blockedReason(isEmail: Bool) -> String? {
		if isApprovable(isEmail: isEmail) { return nil }
		if isEmail, (subject ?? "").trimmed.isEmpty { return "Add a subject to approve." }
		return "Add some text to approve."
	}
}

/// The one path from an edited draft to an approval, used by the For you card and the chat card:
/// read the draft fresh, stop if it changed under the reader, save the edit, check it was saved as
/// typed, and approve the fingerprint of the saved text. An edit changes the fingerprint and
/// withdraws any older approval, so the save always comes first.
///
/// It remembers two things between tries so a retry does not repeat itself: the fingerprint of a
/// text already saved (a retry does not save twice, nor mistake its own save for someone else's
/// change) and the key of an approval request that got no answer (a retry is the same request).
@MainActor
final class DraftSaveAndApprove {
	enum Outcome: Equatable {
		/// Saved if edited, then approved: the preview as it reads now.
		case approved(ObjectPreview)
		/// Approved before this try (here or elsewhere): nothing was saved or approved now.
		case alreadyApproved(ObjectPreview)
		/// Sent before this try: nothing to do.
		case alreadySent
	}

	private let remote: any ObjectDraftsRemote
	private var approvalKeys: [String: String] = [:]
	private var savedHashes: [String: String] = [:]

	init(remote: any ObjectDraftsRemote) { self.remote = remote }

	func reset() {
		approvalKeys = [:]
		savedHashes = [:]
	}

	/// Throws `ObjectApprovalError.changed` when the draft is not the one that was shown (nothing is
	/// saved or approved then), `DraftReviewError` for a draft that is gone or an edit that could not
	/// be saved, and whatever the remote throws.
	func run(_ shown: DraftShown, edit: DraftEdit) async throws -> Outcome {
		let id = shown.objectId
		let detail = try await remote.detail(objectId: id)
		guard let current = detail.preview else {
			throw DraftReviewError("This message isn't a draft any more.")
		}
		if current.delivery == .sent { return .alreadySent }
		if current.delivery == .approved { return .alreadyApproved(current) }
		guard current.contentHash == shown.contentHash || current.contentHash == savedHashes[id] else {
			throw ObjectApprovalError.changed
		}
		var hash = current.contentHash
		if edit.differs(from: shown) {
			hash = try await save(edit, shown: shown, detail: detail, current: current)
		}
		let keyName = "\(id)|\(hash)"
		let key = approvalKeys[keyName] ?? UUID().uuidString
		approvalKeys[keyName] = key
		let approved = try await remote.approve(objectId: id, contentHash: hash, idempotencyKey: key)
		approvalKeys[keyName] = nil
		savedHashes[id] = nil
		return .approved(approved)
	}

	/// Saves the edit and returns the fingerprint of the text as saved. A text already saved by an
	/// earlier try is not saved twice.
	private func save(
		_ edit: DraftEdit, shown: DraftShown, detail: ObjectDetail, current: ObjectPreview
	) async throws -> String {
		let id = shown.objectId
		if current.contentHash == savedHashes[id], Self.matches(edit, current, isEmail: shown.isEmail) {
			return current.contentHash
		}
		let original = detail.object.content ?? ""
		guard var content = DraftBodySplice.replacing(current.body, with: edit.body, in: original) else {
			throw DraftReviewError("Couldn't save your edit. Open the draft to change it.")
		}
		var subject: String?
		if shown.isEmail, let wanted = edit.subject?.trimmed, wanted != (current.subject ?? "").trimmed {
			subject = wanted
			// An older email keeps its subject as the first line of the text: that line must go once
			// the subject has a field of its own, or it would be sent twice.
			if (detail.object.metadata["subject"] ?? "").trimmed.isEmpty {
				content = DraftBodySplice.removingSubjectLine(from: content)
			}
		}
		try await remote.save(
			objectId: id, content: content == original ? nil : content, subject: subject,
			idempotencyKey: UUID().uuidString)
		let after = try await remote.detail(objectId: id)
		guard let saved = after.preview, Self.matches(edit, saved, isEmail: shown.isEmail) else {
			throw DraftReviewError("Couldn't save your edit. Try again.")
		}
		savedHashes[id] = saved.contentHash
		return saved.contentHash
	}

	/// The saved preview reads as the edit does (spaces at the ends aside).
	private static func matches(_ edit: DraftEdit, _ preview: ObjectPreview, isEmail: Bool) -> Bool {
		guard preview.body.trimmed == edit.body.trimmed else { return false }
		return !isEmail || (preview.subject ?? "").trimmed == (edit.subject ?? "").trimmed
	}
}
