import Foundation

/// Hard limits for what the share extension takes on. The extension runs in a separate process
/// with a tight memory budget, so these are deliberately small.
public enum ShareLimits {
	/// `MAX_FILE_SIZE_BYTES` in `packages/shared/src/schemas/files.ts`: `POST /api/files` rejects more.
	public static let maxFileBytes = 10 * 1024 * 1024
	/// Long edge of a shared image after downsampling (ImageIO decodes straight to this size).
	public static let maxImagePixels = 2048
	/// Items taken from one share. The Info.plist activation counts are deliberately higher (10):
	/// an activation rule that fails hides Maskin from the sheet entirely, whereas going over this
	/// limit just keeps the first items and says so.
	public static let maxAttachments = 5
	/// Characters of shared text kept as the object body.
	public static let maxTextCharacters = 20_000
	public static let maxTitleCharacters = 200
}

/// One file the user is sharing, already prepared for upload and parked in a temp file so the
/// bytes are not held in memory until the moment they are sent.
public struct ShareAttachment: Identifiable, Sendable, Equatable {
	public enum Kind: Sendable, Equatable { case image, pdf, file }

	public var id: UUID
	public var kind: Kind
	public var name: String
	public var mimeType: String
	public var fileURL: URL
	public var sizeBytes: Int

	public init(
		id: UUID = UUID(), kind: Kind, name: String, mimeType: String, fileURL: URL, sizeBytes: Int
	) {
		self.id = id
		self.kind = kind
		self.name = name
		self.mimeType = mimeType
		self.fileURL = fileURL
		self.sizeBytes = sizeBytes
	}
}

/// Something in the share that was left out, with a reason a person can read.
public struct ShareSkip: Sendable, Equatable {
	public enum Reason: Sendable, Equatable { case tooLarge, unreadable, unsupported, overLimit, truncatedText }
	public var name: String
	public var reason: Reason

	public init(name: String, reason: Reason) {
		self.name = name
		self.reason = reason
	}

	public var message: String {
		switch reason {
		case .tooLarge: "\(name) is over 10 MB, so it wasn't added."
		case .unreadable: "\(name) couldn't be read, so it wasn't added."
		case .unsupported: "\(name) isn't something Maskin can take."
		case .overLimit: "Only the first \(ShareLimits.maxAttachments) items were added."
		case .truncatedText: "The text was longer than \(ShareLimits.maxTextCharacters) characters, so it was cut."
		}
	}
}

/// Everything extracted from the host app's share, UI-free.
public struct ShareContent: Sendable, Equatable {
	/// A web page, with the page title the host app offered.
	public var link: URL?
	public var linkTitle: String?
	/// Shared plain text (a selection, a note, an email body).
	public var text: String?
	public var attachments: [ShareAttachment]
	public var skipped: [ShareSkip]

	public init(
		link: URL? = nil, linkTitle: String? = nil, text: String? = nil,
		attachments: [ShareAttachment] = [], skipped: [ShareSkip] = []
	) {
		self.link = link
		self.linkTitle = linkTitle
		self.text = text
		self.attachments = attachments
		self.skipped = skipped
	}

	public var isEmpty: Bool { link == nil && (text?.isEmpty ?? true) && attachments.isEmpty }

	/// A title to start the form with: the page title, else the first line of text, else the
	/// first file's name, else the link's host. Never an id.
	public var suggestedTitle: String {
		let candidates: [String?] = [
			linkTitle, text.flatMap(Self.firstLine), attachments.first.map { Self.stem($0.name) },
			link?.host,
		]
		for case let candidate? in candidates {
			let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
			if !trimmed.isEmpty { return String(trimmed.prefix(ShareLimits.maxTitleCharacters)) }
		}
		return ""
	}

	static func firstLine(_ text: String) -> String? {
		text.split(whereSeparator: \.isNewline).lazy
			.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
	}

	static func stem(_ name: String) -> String {
		let stem = (name as NSString).deletingPathExtension
		return stem.isEmpty ? name : stem
	}

	/// Removes the temp files, and the `maskin-share-*` directory they were staged in. Call when
	/// the share is done, whatever the outcome.
	public func cleanUp() {
		for attachment in attachments {
			try? FileManager.default.removeItem(at: attachment.fileURL)
			let directory = attachment.fileURL.deletingLastPathComponent()
			if directory.lastPathComponent.hasPrefix(ShareExtractor.workDirectoryPrefix) {
				try? FileManager.default.removeItem(at: directory)
			}
		}
	}

	/// A stable identity for "the same share", so a saved draft only comes back for the content it
	/// was written for.
	public var fingerprint: String {
		var parts = [link?.absoluteString ?? "", String((text ?? "").prefix(200)), String((text ?? "").count)]
		parts.append(contentsOf: attachments.map(\.name))
		return parts.joined(separator: "|")
	}
}

/// Where a share goes.
public enum ShareDestination: Sendable, Equatable, Hashable {
	/// A new object of this workspace type (`insight`, `bet`, `task`, or a custom type).
	case object(type: String)
	/// Just the files, with no object around them.
	case filesOnly
	/// A message in an existing conversation, with any files attached to it.
	case chat(id: String)
}

/// What the user decided in the sheet.
public struct ShareRequest: Sendable, Equatable {
	public var destination: ShareDestination
	public var title: String
	public var note: String
	public var content: ShareContent
	/// The first status of the destination type in the workspace's own list.
	public var status: String

	public init(
		destination: ShareDestination, title: String, note: String, content: ShareContent,
		status: String
	) {
		self.destination = destination
		self.title = title
		self.note = note
		self.content = content
		self.status = status
	}
}

/// Builds the body and title of the object that is created. Pure, so the exact text is tested.
public enum ShareComposer {
	/// Markdown: the user's note first, then the link, then shared text (quoted when it sits next
	/// to a note or a link, so it reads as the source rather than as the user's own words).
	public static func objectContent(note: String, content: ShareContent) -> String {
		let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
		let text = (content.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		let quoteText = !note.isEmpty || content.link != nil
		var parts: [String] = []
		if !note.isEmpty { parts.append(note) }
		if let link = content.link { parts.append(linkLine(link, title: content.linkTitle)) }
		if !text.isEmpty {
			let clipped = String(text.prefix(ShareLimits.maxTextCharacters))
			parts.append(quoteText ? quote(clipped) : clipped)
		}
		return parts.joined(separator: "\n\n")
	}

	/// The text of a chat message: the note, then the link, then the shared text. A share with only
	/// files still needs words, so it falls back to the suggested title.
	public static func chatMessage(note: String, content: ShareContent) -> String {
		let body = objectContent(note: note, content: content)
		if !body.isEmpty { return body }
		return content.suggestedTitle
	}

	/// The title sent to the server: the user's, else the suggestion. Trimmed and capped.
	public static func objectTitle(_ title: String, content: ShareContent) -> String {
		let own = title.trimmingCharacters(in: .whitespacesAndNewlines)
		let chosen = own.isEmpty ? content.suggestedTitle : own
		return String(chosen.prefix(ShareLimits.maxTitleCharacters))
	}

	static func linkLine(_ url: URL, title: String?) -> String {
		let title = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let address = url.absoluteString
		// Brackets in a title would end the markdown label early.
		let label = title.replacingOccurrences(of: "[", with: "(").replacingOccurrences(of: "]", with: ")")
		return label.isEmpty || label == address ? "<\(address)>" : "[\(label)](\(address))"
	}

	static func quote(_ text: String) -> String {
		text.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
	}
}
