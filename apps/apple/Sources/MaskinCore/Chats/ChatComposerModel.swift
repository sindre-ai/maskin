import Foundation
import Observation

/// A person or agent picked with `@`. The message carries only the id (`metadata.mentions`); the
/// name is for the composer chip and the bubble.
public struct ChatMention: Equatable, Hashable, Identifiable, Sendable {
	public var id: String
	public var name: String
	public var kind: ChatParticipant.Kind

	public init(id: String, name: String, kind: ChatParticipant.Kind) {
		self.id = id
		self.name = name
		self.kind = kind
	}
}

/// An attachment on its way into a message: uploading, uploaded (carries the file reference the
/// message will cite) or failed (can be retried or removed).
public struct ChatAttachmentDraft: Identifiable, Equatable, Sendable {
	public enum State: Equatable, Sendable {
		case uploading
		case uploaded(ChatAttachmentRef)
		case failed(String)
	}

	public var id: String
	public var name: String
	public var mimeType: String
	public var state: State

	public var ref: ChatAttachmentRef? {
		if case .uploaded(let ref) = state { return ref }
		return nil
	}
	public var isImage: Bool { mimeType.hasPrefix("image/") }
}

/// A file ready to upload (already loaded and, for photos, downsampled).
public struct PreparedChatFile: Sendable {
	public var name: String
	public var mimeType: String
	public var data: Data

	public init(name: String, mimeType: String, data: Data) {
		self.name = name
		self.mimeType = mimeType
		self.data = data
	}
}

/// What the user is composing: text, `@` mentions and attachments. UI-free so the rules (limits,
/// "can't send while an upload is running", mention extraction) are tested without a view.
@MainActor
@Observable
public final class ChatComposerModel {
	public var text = ""
	/// The caret or selection as character offsets, kept by the text field. Nil until the field
	/// reports one, in which case edits act at the end of the text.
	public var selection: Range<Int>?
	/// A selection the text field should adopt after an edit made here (a format, an inserted
	/// emoji). `id` changes on every request so the same range can be asked for twice.
	public private(set) var selectionRequest: SelectionRequest?
	/// Bumped when something outside the field (quoting a message) wants the keyboard up.
	public private(set) var focusRequest = 0
	public private(set) var mentions: [ChatMention] = []
	public private(set) var attachments: [ChatAttachmentDraft] = []
	/// A rule the last action ran into ("That file is over 10 MB."), shown once then cleared.
	public var notice: String?

	public struct SelectionRequest: Equatable, Sendable {
		public var id: Int
		public var range: Range<Int>
	}

	@ObservationIgnored private var selectionRequests = 0
	@ObservationIgnored private let uploader: (any ChatFileUploading)?
	@ObservationIgnored private let selfActorID: String
	@ObservationIgnored private var jobs: [String: Task<Void, Never>] = [:]
	@ObservationIgnored private var retryLoaders: [String: @Sendable () async throws -> PreparedChatFile] = [:]

	public init(uploader: (any ChatFileUploading)?, selfActorID: String) {
		self.uploader = uploader
		self.selfActorID = selfActorID
	}

	deinit { MainActor.assumeIsolated { for job in jobs.values { job.cancel() } } }

	// MARK: Send

	public var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
	public var isUploading: Bool { attachments.contains { $0.state == .uploading } }
	public var hasFailedAttachment: Bool {
		attachments.contains { if case .failed = $0.state { return true } else { return false } }
	}
	public var isOverLength: Bool { trimmedText.count > ChatLimits.maxMessageLength }

	/// Text is required (the API rejects an empty message); every attachment must have settled.
	public var canSend: Bool {
		!trimmedText.isEmpty && !isOverLength && !isUploading && !hasFailedAttachment
	}

	/// Why Send is off, for an accessibility hint.
	public var sendBlocker: String? {
		if isUploading { return "Waiting for attachments to upload" }
		if hasFailedAttachment { return "Remove or retry the attachment that failed" }
		if isOverLength { return "Message is too long" }
		return nil
	}

	/// The message to send, and the composer cleared. Nil when `canSend` is false.
	public func take() -> (text: String, metadata: ChatSendMetadata?)? {
		guard canSend else { return nil }
		let metadata = ChatSendMetadata(
			attachments: attachments.compactMap(\.ref),
			mentions: Array(
				mentions.map(\.id).filter { $0 != selfActorID }.prefix(ChatSendMetadata.maxMentions)))
		let result = (EmojiShortcodes.expand(trimmedText), metadata.isEmpty ? nil : metadata)
		clear()
		return result
	}

	public func clear() {
		text = ""
		selection = nil
		selectionRequest = nil
		mentions = []
		attachments = []
		for job in jobs.values { job.cancel() }
		jobs = [:]
		retryLoaders = [:]
	}

	// MARK: Editing

	private var caret: Range<Int> { selection ?? text.count..<text.count }

	private func setText(_ new: String, selecting range: Range<Int>) {
		text = new
		selection = range
		selectionRequests += 1
		selectionRequest = SelectionRequest(id: selectionRequests, range: range)
	}

	/// Bold, a list, a code block, and so on, applied to the selection (or the caret).
	public func applyFormat(_ format: MarkdownFormat) {
		let edit = MarkdownFormatting.apply(format, to: text, selection: caret)
		setText(edit.text, selecting: edit.selection)
	}

	/// Put `string` at the caret, replacing any selection, and leave the caret after it.
	public func insert(_ string: String) {
		var chars = Array(text)
		let range = caret
		let lower = min(range.lowerBound, chars.count)
		let upper = min(range.upperBound, chars.count)
		chars.replaceSubrange(lower..<upper, with: Array(string))
		let end = lower + string.count
		setText(String(chars), selecting: end..<end)
	}

	/// Complete the `:query` being typed with the chosen emoji.
	public func pickEmoji(_ emoji: String) {
		guard let trigger = EmojiTrigger.find(in: text) else {
			insert(emoji)
			return
		}
		var new = text
		new.replaceSubrange(trigger.range, with: emoji)
		let end = new.count
		setText(new, selecting: end..<end)
	}

	/// Start a reply to a message: it is quoted above whatever is already typed.
	public func quote(author: String, content: String) {
		let quoted = ChatQuote.make(author: author, content: content)
		guard !quoted.isEmpty else { return }
		let new = quoted + text
		let end = new.count
		setText(new, selecting: end..<end)
		focusRequest += 1
	}

	// MARK: Mentions

	public func addMention(_ mention: ChatMention) {
		guard mention.id != selfActorID, !mentions.contains(where: { $0.id == mention.id }),
			mentions.count < ChatSendMetadata.maxMentions
		else { return }
		mentions.append(mention)
	}

	public func removeMention(_ id: String) { mentions.removeAll { $0.id == id } }

	/// Commit a picked mention: the `@query` leaves the text (the mention rides as metadata, shown
	/// as a chip, exactly like the web composer) and the actor joins `mentions`.
	public func pick(_ mention: ChatMention) {
		if let trigger = MentionTrigger.find(in: text) {
			text.replaceSubrange(trigger.range, with: "")
			if text.last.map({ !$0.isWhitespace }) == true { text += " " }
		}
		addMention(mention)
	}

	// MARK: Attachments

	/// Add a file. `prepare` runs off the main actor (loading and downsampling a photo can be
	/// slow and large) and the chip shows at once in its uploading state.
	@discardableResult
	public func attach(
		name: String, mimeType: String, prepare: @escaping @Sendable () async throws -> PreparedChatFile
	) -> String? {
		guard attachments.count < ChatLimits.maxAttachments else {
			notice = "You can attach up to \(ChatLimits.maxAttachments) files."
			return nil
		}
		let id = UUID().uuidString
		attachments.append(ChatAttachmentDraft(id: id, name: name, mimeType: mimeType, state: .uploading))
		retryLoaders[id] = prepare
		start(id, prepare: prepare)
		return id
	}

	public func retryAttachment(_ id: String) {
		guard let index = attachments.firstIndex(where: { $0.id == id }),
			case .failed = attachments[index].state, let prepare = retryLoaders[id]
		else { return }
		attachments[index].state = .uploading
		start(id, prepare: prepare)
	}

	public func removeAttachment(_ id: String) {
		jobs[id]?.cancel()
		jobs[id] = nil
		retryLoaders[id] = nil
		attachments.removeAll { $0.id == id }
	}

	private func start(_ id: String, prepare: @escaping @Sendable () async throws -> PreparedChatFile) {
		guard let uploader else {
			finish(id, .failed("Attachments aren't available right now."))
			return
		}
		jobs[id] = Task { [weak self] in
			do {
				let file = try await prepare()
				guard file.data.count <= ChatLimits.maxFileBytes else {
					self?.finish(id, .failed("Over the 10 MB limit."))
					return
				}
				let ref = try await uploader.upload(name: file.name, mimeType: file.mimeType, data: file.data)
				try Task.checkCancellation()
				var uploaded = ref
				uploaded.name = uploaded.name ?? file.name
				uploaded.mimeType = uploaded.mimeType ?? file.mimeType
				uploaded.sizeBytes = uploaded.sizeBytes ?? file.data.count
				self?.finish(id, .uploaded(uploaded))
			} catch is CancellationError {
				return
			} catch {
				self?.finish(id, .failed(Self.reason(error)))
			}
		}
	}

	private func finish(_ id: String, _ state: ChatAttachmentDraft.State) {
		guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
		attachments[index].state = state
		jobs[id] = nil
	}

	private static func reason(_ error: any Error) -> String {
		if let chats = error as? ChatsError { return chats.message }
		if error is URLError { return "No connection. Retry when you're online." }
		if let prep = error as? ChatAttachmentError { return prep.message }
		return "Couldn't upload this file."
	}
}

public struct ChatAttachmentError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}

/// Finds an in-progress `@name` at the end of the text: an `@` at the start or after whitespace,
/// followed by non-space characters up to the end. (Typing happens at the end; moving the caret
/// to edit the middle simply closes the picker.)
public enum MentionTrigger {
	public struct Match: Equatable {
		public var range: Range<String.Index>
		public var query: String
	}

	public static func find(in text: String) -> Match? {
		guard let at = text.lastIndex(of: "@") else { return nil }
		if at > text.startIndex, !text[text.index(before: at)].isWhitespace { return nil }
		let query = text[text.index(after: at)...]
		if query.contains(where: \.isWhitespace) { return nil }
		return Match(range: at..<text.endIndex, query: String(query))
	}

	/// Candidates for the picker: people in this conversation first, then the rest of the
	/// workspace; matched case-insensitively on the name. Never the signed-in actor, never system
	/// actors.
	public static func candidates(
		query: String, participants: [ChatParticipant], workspace: [ChatActor], selfID: String,
		excluding picked: Set<String>
	) -> [ChatParticipant] {
		func ok(_ p: ChatParticipant) -> Bool {
			p.id != selfID && !picked.contains(p.id)
				&& (query.isEmpty || p.name.localizedCaseInsensitiveContains(query))
		}
		let inChat = participants.filter(ok)
		let seen = Set(inChat.map(\.id))
		let others = workspace.filter { !$0.isSystem && !seen.contains($0.id) }.map(\.participant).filter(ok)
		return inChat + others.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
	}
}

/// Merges live dictation into the draft: the text typed before the mic opened, then the
/// recogniser's running transcript.
public enum DictationText {
	public static func merge(base: String, transcript: String) -> String {
		let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !spoken.isEmpty else { return base }
		guard !base.isEmpty else { return spoken }
		return base.last?.isWhitespace == true ? base + spoken : base + " " + spoken
	}
}
