import Foundation

/// A message an agent drafted that the reader can edit and approve from For you: an email, a
/// LinkedIn post or message, a Slack message. Always backed by an object that holds the text, so an
/// edit has somewhere to be saved and the approval is bound to that exact text.
public struct ReviewDraft: Identifiable, Equatable, Sendable {
	/// The object that holds the draft text.
	public var objectId: String
	/// The For you card the draft arrived on (what Send is answered under).
	public var target: DecisionTarget
	/// The agent's key for this message when its card carries several.
	public var draftKey: String?
	/// "Email", "LinkedIn post": the kind, as the server names it.
	public var kind: String
	public var kindLabel: String
	/// The agent that wrote it; nil when its name is not known yet.
	public var agentName: String?
	/// The reply label the agent reads back ("Email to Mette").
	public var label: String
	/// Who it goes to as the agent wrote it ("Mette Holm, Northwind"); nil for a public post.
	public var to: String?
	/// To, as the server resolved it (names and addresses).
	public var recipients: [ObjectPreview.Recipient]
	public var subject: String?
	public var body: String
	/// Fingerprint of what would go out, sent back when approving.
	public var contentHash: String
	/// Required things the draft still lacks. While any is missing it cannot be approved.
	public var missing: [String]

	public var id: String { objectId }

	public init(
		objectId: String, target: DecisionTarget, draftKey: String? = nil, kind: String,
		kindLabel: String, agentName: String? = nil, label: String, to: String? = nil,
		recipients: [ObjectPreview.Recipient] = [], subject: String? = nil, body: String,
		contentHash: String, missing: [String] = []
	) {
		self.objectId = objectId
		self.target = target
		self.draftKey = draftKey
		self.kind = kind
		self.kindLabel = kindLabel
		self.agentName = agentName
		self.label = label
		self.to = to
		self.recipients = recipients
		self.subject = subject
		self.body = body
		self.contentHash = contentHash
		self.missing = missing
	}

	public var isEmail: Bool { kind == "email" }
	public var isPost: Bool { kind == "linkedin_post" }

	/// The grey tag on the card: "EMAIL DRAFT", "LINKEDIN POST".
	public var chip: String {
		if isEmail { return "EMAIL DRAFT" }
		if isPost { return "LINKEDIN POST" }
		return kindLabel.uppercased()
	}

	/// The line under the tag: who wrote it. The loop it ran in is not in the feed yet.
	public var source: String { agentName ?? "An agent" }

	public var hint: String { isEmail ? "Edit subject or body" : "Tap the text to edit" }

	public var approveTitle: String { isPost ? "Approve and post" : "Approve and send" }

	/// The first person it goes to, by name: "Mette Holm".
	public var recipientName: String? {
		guard let first = recipients.first(where: { $0.role == "to" }) ?? recipients.first else {
			return to?.components(separatedBy: ",").first?.trimmed.nonEmpty
		}
		return (first.name ?? first.address)?.trimmed.nonEmpty
	}

	/// The To line, read only.
	public var toLine: String? {
		let line = recipients.filter { $0.role == "to" }.map(\.displayText).filter { !$0.isEmpty }
			.joined(separator: ", ")
		return line.nonEmpty ?? to?.trimmed.nonEmpty
	}

	/// What the receipt says once it has gone: "Email sent to Mette Holm.", "Posted to LinkedIn."
	public var sentText: String {
		if isPost { return "Posted to LinkedIn." }
		let name = recipientName.map { " to \($0)" } ?? ""
		return isEmail ? "Email sent\(name)." : "\(kindLabel) sent\(name)."
	}

	/// What the receipt says while the Undo window is open.
	public var sendingText: String {
		if isPost { return "Posting to LinkedIn…" }
		return "Sending\(recipientName.map { " to \($0)" } ?? "")…"
	}

	/// A draft the strip can edit and approve: a message held by an object, with a preview, not
	/// already approved or sent.
	public static func isReviewable(_ draft: DecisionDraft) -> Bool {
		guard draft.file == nil, draft.objectId != nil, let preview = draft.preview else { return false }
		return preview.delivery != .approved && preview.delivery != .sent
	}

	/// The open drafts on a card that this screen can edit and approve: object-backed, a kind an
	/// integration can deliver, and not already approved or sent.
	public static func drafts(in card: ForYouCard, agentName: String?) -> [ReviewDraft] {
		guard let decision = card.decision else { return [] }
		let all = (decision.draft.map { [$0] } ?? []) + decision.drafts
		return all.compactMap { draft in
			guard isReviewable(draft), let objectId = draft.objectId, let preview = draft.preview
			else { return nil }
			return ReviewDraft(
				objectId: objectId, target: DecisionTarget(card), draftKey: draft.id, kind: preview.kind,
				kindLabel: preview.label, agentName: agentName, label: draft.label, to: draft.to,
				recipients: preview.recipients, subject: preview.subject, body: preview.body,
				contentHash: preview.contentHash, missing: preview.missing)
		}
	}
}

/// What the reader has changed in a draft, kept apart from the original so Revert is exact.
public struct DraftEdit: Equatable, Sendable {
	public var body: String
	public var subject: String?

	public init(body: String, subject: String? = nil) {
		self.body = body
		self.subject = subject
	}

	/// The edit of an untouched draft.
	public init(_ draft: ReviewDraft) {
		self.init(body: draft.body, subject: draft.isEmail ? (draft.subject ?? "") : nil)
	}

	public func differs(from draft: ReviewDraft) -> Bool { self != DraftEdit(draft) }
}

/// Puts an edited message back into the text of the object that holds it. A LinkedIn post keeps
/// its text between markers, below a header; an email's text is the whole description. The
/// preview shows only the message, so the message is found inside the description and swapped.
public enum DraftBodySplice {
	/// The description with `old` (the message as previewed) replaced by `new`, or nil when `old`
	/// cannot be found in it (the description changed shape: the edit must not guess).
	public static func replacing(_ old: String, with new: String, in content: String) -> String? {
		if content == old { return new }
		if let range = content.range(of: old) { return content.replacingCharacters(in: range, with: new) }
		let trimmed = old.trimmed
		if !trimmed.isEmpty, let range = content.range(of: trimmed) {
			return content.replacingCharacters(in: range, with: new.trimmed)
		}
		return nil
	}

	/// An older email keeps its subject as the first line ("Subject: Hello") of the description. A
	/// subject saved to the object's own field must not leave that line behind in the message.
	public static func removingSubjectLine(from content: String) -> String {
		let lines = content.components(separatedBy: "\n")
		guard let index = lines.firstIndex(where: { !$0.trimmed.isEmpty }),
			lines[index].trimmed.lowercased().hasPrefix("subject:")
		else { return content }
		var rest = lines
		rest.remove(at: index)
		if index < rest.count, rest[index].trimmed.isEmpty { rest.remove(at: index) }
		return rest.joined(separator: "\n")
	}
}
