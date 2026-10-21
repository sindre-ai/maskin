import Foundation

/// What a person needs to read, check and approve something an agent wants to send: the
/// `preview` the server computes for an object that carries a deliverable `kind` (an email, a
/// LinkedIn message or post, a Slack message). Drawn the same way on the web, here and in Claude.
/// Never stored: the server rebuilds it from the object's current text on every read.
public struct ObjectPreview: Sendable, Equatable, Hashable, Codable {
	public struct Recipient: Sendable, Equatable, Hashable, Codable {
		/// `to` or `cc`.
		public var role: String
		public var name: String?
		public var address: String?

		public init(role: String, name: String? = nil, address: String? = nil) {
			self.role = role
			self.name = name
			self.address = address
		}

		/// "Name <address>" when both are known, never one without the other.
		public var displayText: String {
			switch (name, address) {
			case let (name?, address?): "\(name) <\(address)>"
			case let (name?, nil): name
			case let (nil, address?): address
			default: ""
			}
		}
	}

	/// A labelled line that is not a recipient or the subject: the account a post is published as,
	/// a Slack channel.
	public struct Detail: Sendable, Equatable, Hashable, Codable {
		public var label: String
		public var value: String

		public init(label: String, value: String) {
			self.label = label
			self.value = value
		}
	}

	/// Where the draft stands, read from the object's own events.
	public enum Delivery: String, Sendable, Equatable, Hashable, Codable {
		case draft, approved, sent
	}

	/// `email`, `linkedin_message`, `linkedin_connection_request`, `linkedin_post`, `slack_message`.
	public var kind: String
	/// Human label of the kind: "Email", "LinkedIn post".
	public var label: String
	public var recipients: [Recipient]
	public var subject: String?
	public var details: [Detail]
	/// The exact text that would go out.
	public var body: String
	/// Required fields that are empty. While any is missing the draft cannot be approved.
	public var missing: [String]
	/// Things to check before approving, in plain words.
	public var warnings: [String]
	/// Fingerprint of what would go out. Send it back when approving so a draft that changed since
	/// it was shown is refused.
	public var contentHash: String
	public var delivery: Delivery?

	public init(
		kind: String, label: String, recipients: [Recipient] = [], subject: String? = nil,
		details: [Detail] = [], body: String, missing: [String] = [], warnings: [String] = [],
		contentHash: String, delivery: Delivery? = nil
	) {
		self.kind = kind
		self.label = label
		self.recipients = recipients
		self.subject = subject
		self.details = details
		self.body = body
		self.missing = missing
		self.warnings = warnings
		self.contentHash = contentHash
		self.delivery = delivery
	}

	/// A draft with nothing missing can be approved.
	public var canApprove: Bool { missing.isEmpty }

	/// The lines above the body, in reading order: To, Cc, Subject, then the kind's own details.
	/// Empty values are left out.
	public var metaRows: [Detail] {
		func line(_ role: String) -> String {
			recipients.filter { $0.role == role }.map(\.displayText).filter { !$0.isEmpty }
				.joined(separator: ", ")
		}
		var rows: [Detail] = []
		let to = line("to"), cc = line("cc")
		if !to.isEmpty { rows.append(Detail(label: "To", value: to)) }
		if !cc.isEmpty { rows.append(Detail(label: "Cc", value: cc)) }
		if let subject = subject?.trimmingCharacters(in: .whitespacesAndNewlines), !subject.isEmpty {
			rows.append(Detail(label: "Subject", value: subject))
		}
		rows.append(contentsOf: details.filter { !$0.value.isEmpty })
		return rows
	}
}

/// A workspace file a card is about: enough to draw its header without a second lookup. The bytes
/// are fetched when the card opens (or at once for a picture).
public struct FileReference: Sendable, Equatable, Hashable, Codable, Identifiable {
	public var id: String
	public var name: String
	public var mimeType: String
	public var sizeBytes: Int

	public init(id: String, name: String, mimeType: String, sizeBytes: Int) {
		self.id = id
		self.name = name
		self.mimeType = mimeType
		self.sizeBytes = sizeBytes
	}
}

extension FileReference {
	/// The short type name on a file card.
	public var kindLabel: String {
		let mime = mimeType.lowercased()
		if mime.hasPrefix("image/") { return "Image" }
		if mime == "text/html" { return "HTML page" }
		if mime == "text/markdown" || name.lowercased().hasSuffix(".md") { return "Markdown" }
		if mime.hasPrefix("text/") { return "Text" }
		return "File"
	}

	public var isImage: Bool { mimeType.lowercased().hasPrefix("image/") }
}
