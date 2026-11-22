import Foundation
import Testing

@testable import MaskinCore

/// The composer rules the bigger suites leave out: where a trigger lands, what Send says when it is
/// off, what an edit may take, and what an undone send puts back.
@Suite("ChatComposerModel rules")
@MainActor
struct ChatComposerGapTests {
	private struct Uploader: ChatFileUploading {
		func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
			ChatAttachmentRef(fileID: "f-\(name)", name: name, mimeType: mimeType, sizeBytes: data.count)
		}
	}

	private func model(uploader: Bool = true) -> ChatComposerModel {
		ChatComposerModel(uploader: uploader ? Uploader() : nil, selfActorID: "me")
	}

	private let picture: @Sendable () async throws -> PreparedChatFile = {
		PreparedChatFile(name: "a.png", mimeType: "image/png", data: Data(count: 4))
	}
	private let broken: @Sendable () async throws -> PreparedChatFile = { throw ChatAttachmentError("Nope.") }

	private var overLength: String { String(repeating: "x", count: ChatLimits.maxMessageLength + 1) }

	// MARK: Triggers

	@Test("a trigger in an empty box is the whole text")
	func triggerInEmptyBox() {
		let m = model()
		m.insertTrigger("@")
		#expect(m.text == "@")
	}

	@Test("a trigger after a word gets a space first, so it starts a word")
	func triggerAfterWord() {
		let m = model()
		m.text = "ask"
		m.insertTrigger("@")
		#expect(m.text == "ask @")
		#expect(MentionTrigger.find(in: m.text)?.query == "")
	}

	@Test("a trigger after a space or a new line adds no second space")
	func triggerAfterWhitespace() {
		let spaced = model()
		spaced.text = "ask "
		spaced.insertTrigger("/")
		#expect(spaced.text == "ask /")
		let lined = model()
		lined.text = "ask\n"
		lined.insertTrigger("@")
		#expect(lined.text == "ask\n@")
	}

	@Test("the caret ends after the trigger")
	func triggerMovesCaret() {
		let m = model()
		m.text = "ask"
		m.insertTrigger("@")
		#expect(m.selection == 5..<5)
	}

	// MARK: Send is off

	@Test("a plain message has no reason to hold Send back")
	func noBlocker() {
		let m = model()
		m.text = "hello"
		#expect(m.canSend)
		#expect(m.sendBlocker == nil)
	}

	@Test("a failed attachment says to remove or retry it")
	func failedAttachmentBlocker() async {
		let m = model()
		m.text = "hello"
		m.attach(name: "a.png", mimeType: "image/png", prepare: broken)
		#expect(await eventually { m.hasFailedAttachment })
		#expect(!m.canSend)
		#expect(m.sendBlocker == "Remove or retry the attachment that failed")
	}

	@Test("a failed upload puts its reason under the bar, with the file's name")
	func failedAttachmentNotice() async {
		let m = model()
		m.attach(name: "a.png", mimeType: "image/png", prepare: broken)
		#expect(await eventually { m.notice != nil })
		#expect(m.notice == "a.png: Nope.")
	}

	@Test("with no uploader an attachment fails at once and says attachments are off")
	func noUploaderFailsAttachment() {
		let m = model(uploader: false)
		m.attach(name: "a.png", mimeType: "image/png", prepare: picture)
		#expect(m.hasFailedAttachment)
		#expect(m.notice == "a.png: Attachments aren't available right now.")
	}

	@Test("a long message with a full row of attachments cannot go as a file, and says to remove one")
	func longMessageNeedsRoomForTheFile() async {
		let m = model()
		m.splitsLongMessages = true
		for index in 0..<ChatLimits.maxAttachments {
			m.attach(name: "a\(index).png", mimeType: "image/png", prepare: picture)
		}
		#expect(await eventually { !m.isUploading })
		m.text = overLength
		#expect(!m.sendsAsFile)
		#expect(!m.canSend)
		#expect(m.sendBlocker == "Message is too long")
		#expect(m.lengthNotice?.hasPrefix("Remove an attachment to send this as a file") == true)
	}

	@Test("an attachment alone can send, with empty text and the file in the metadata")
	func attachmentAloneCanSend() async {
		let m = model()
		m.attach(name: "a.png", mimeType: "image/png", prepare: picture)
		#expect(!m.canSend)  // still uploading
		#expect(await eventually { !m.isUploading })
		#expect(m.hasContent)
		#expect(m.canSend)
		let taken = m.take()
		#expect(taken?.text == "")
		#expect(taken?.metadata?.attachments?.count == 1)
	}

	@Test("blank text and no attachment cannot send")
	func nothingCannotSend() {
		let m = model()
		m.text = "  \n"
		#expect(!m.canSend)
		#expect(m.take() == nil)
	}

	@Test("a comment with no words goes with the attachments' names")
	func commentTextFallsBackToNames() async {
		let m = model()
		m.attach(name: "a.png", mimeType: "image/png", prepare: picture)
		m.attach(name: "b.pdf", mimeType: "application/pdf", prepare: picture)
		#expect(m.commentText == "a.png, b.pdf")
		m.text = " hello "
		#expect(m.commentText == "hello")
	}

	// MARK: Edit and reply

	@Test("an edit with no words left saves nothing")
	func blankEditSavesNothing() {
		let m = model()
		m.beginEdit(messageID: "m1", text: "hello")
		m.text = "   "
		#expect(m.takeEdit() == nil)
		#expect(m.editing?.messageID == "m1")
	}

	@Test("an edit is never sent as a new message")
	func editIsNotASend() {
		let m = model()
		m.beginEdit(messageID: "m1", text: "hello")
		#expect(m.take() == nil)
	}

	@Test("with no edit open, takeEdit gives nothing and keeps the text")
	func takeEditWithoutEdit() {
		let m = model()
		m.text = "hello"
		#expect(m.takeEdit() == nil)
		#expect(m.text == "hello")
	}

	@Test("replying to a blank message opens no strip")
	func blankReplyIgnored() {
		let m = model()
		m.beginReply(author: "Forge", content: "  \n ")
		#expect(m.quote == nil)
		#expect(m.replyTo == nil)
	}

	@Test("cancelling a reply keeps what was typed")
	func cancellingReplyKeepsText() {
		let m = model()
		m.text = "typed"
		m.beginReply(author: "Forge", content: "earlier")
		m.cancelQuote()
		#expect(m.quote == nil)
		#expect(m.text == "typed")
	}

	@Test("a reply sends the quoted message id")
	func replyCarriesServerID() {
		let m = model()
		m.text = "yes"
		m.beginReply(author: "Forge", content: "shall I?", serverID: 42)
		#expect(m.take()?.metadata?.quotedMessageId == 42)
	}

	// MARK: Mentions

	@Test("no more mentions than a message may carry")
	func mentionCap() {
		let m = model()
		for index in 0...ChatSendMetadata.maxMentions {
			m.addMention(ChatMention(id: "a\(index)", name: "Agent \(index)", kind: .agent))
		}
		#expect(m.mentions.count == ChatSendMetadata.maxMentions)
	}

	@Test("removing a mention chip takes it off the message")
	func removingMention() {
		let m = model()
		m.text = "hi"
		m.addMention(ChatMention(id: "a1", name: "Forge", kind: .agent))
		m.removeMention("a1")
		#expect(m.take()?.metadata == nil)
	}

	// MARK: Undone send

	@Test("an undone send puts uploaded attachments back once, not twice")
	func restoreAttachments() async {
		let m = model()
		m.text = "see this"
		m.attach(name: "a.png", mimeType: "image/png", prepare: picture)
		#expect(await eventually { m.canSend })
		let snapshot = m.snapshot()
		#expect(m.take() != nil)
		#expect(m.attachments.isEmpty)
		m.restore(snapshot)
		m.restore(snapshot)
		#expect(m.attachments.count == 1)
		#expect(m.canSend)
	}

	@Test("an attachment that never uploaded is not kept in the snapshot")
	func snapshotSkipsUnfinished() {
		let m = model(uploader: false)
		m.text = "x"
		m.attach(name: "a.png", mimeType: "image/png", prepare: picture)
		#expect(m.snapshot().attachments.isEmpty)
	}

	@Test("clearing the bar drops text, chips, attachments and the reply together")
	func clearEverything() {
		let m = model()
		m.text = "hello"
		m.addMention(ChatMention(id: "a1", name: "Forge", kind: .agent))
		m.beginReply(author: "Forge", content: "earlier")
		m.attach(name: "a.png", mimeType: "image/png", prepare: picture)
		m.clear()
		#expect(m.text.isEmpty && m.mentions.isEmpty && m.attachments.isEmpty && m.quote == nil)
		#expect(!m.hasContent)
	}
}
