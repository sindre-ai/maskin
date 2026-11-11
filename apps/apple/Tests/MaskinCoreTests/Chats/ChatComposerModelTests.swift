import Foundation
import Testing

@testable import MaskinCore

private actor FakeUploader: ChatFileUploading {
	var uploaded: [String] = []
	var failures: [any Error] = []
	var gate: CheckedContinuation<Void, Never>?
	var hold = false

	func failNext(_ error: any Error) { failures.append(error) }
	func holdUploads() { hold = true }
	func release() {
		hold = false
		gate?.resume()
		gate = nil
	}

	func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
		if hold { await withCheckedContinuation { gate = $0 } }
		if !failures.isEmpty { throw failures.removeFirst() }
		uploaded.append(name)
		return ChatAttachmentRef(fileID: "file-\(uploaded.count)", name: name, mimeType: mimeType, sizeBytes: data.count)
	}
}

private func file(_ name: String = "a.png", bytes: Int = 10) -> @Sendable () async throws -> PreparedChatFile {
	{ PreparedChatFile(name: name, mimeType: "image/png", data: Data(count: bytes)) }
}

@Suite("ChatComposerModel")
@MainActor
struct ChatComposerModelTests {
	private func model(_ uploader: FakeUploader = FakeUploader()) -> ChatComposerModel {
		ChatComposerModel(uploader: uploader, selfActorID: "me")
	}

	@Test("text is required, whitespace doesn't count, and over-length is blocked")
	func canSend() {
		let m = model()
		#expect(!m.canSend)
		m.text = "   \n"
		#expect(!m.canSend)
		m.text = "hi"
		#expect(m.canSend)
		m.text = String(repeating: "x", count: ChatLimits.maxMessageLength + 1)
		#expect(!m.canSend)
		#expect(m.sendBlocker == "Message is too long")
	}

	private func longModel(_ uploader: FakeUploader = FakeUploader()) -> ChatComposerModel {
		let m = model(uploader)
		m.splitsLongMessages = true
		return m
	}

	@Test("a chat host sends text over the cap as a file, exactly at the cap it stays a message")
	func longMessageBoundary() {
		let m = longModel()
		m.text = String(repeating: "x", count: ChatLimits.maxMessageLength)
		#expect(m.canSend && !m.isOverLength && m.lengthNotice == nil)
		m.text = String(repeating: "x", count: ChatLimits.maxMessageLength + 1)
		#expect(m.canSend && m.sendsAsFile)
		#expect(m.lengthNotice?.contains("attached as a file") == true)
		#expect(m.take() == nil)
	}

	@Test("a host that is not a chat, or has no uploader, still blocks over-length with a reason")
	func longMessageBlocked() {
		let over = String(repeating: "x", count: ChatLimits.maxMessageLength + 1)
		let comment = model()
		comment.text = over
		#expect(!comment.canSend)
		#expect(comment.lengthNotice == "A message can be at most 8,000 characters.")
		let noUploader = ChatComposerModel(uploader: nil, selfActorID: "me")
		noUploader.splitsLongMessages = true
		noUploader.text = over
		#expect(!noUploader.canSend)
	}

	@Test("an over-long edit stays blocked and says why")
	func longEditBlocked() {
		let m = longModel()
		m.beginEdit(messageID: "m1", text: String(repeating: "x", count: ChatLimits.maxMessageLength + 1))
		#expect(!m.canSend)
		#expect(m.takeEdit() == nil)
		#expect(m.lengthNotice == "An edited message can be at most 8,000 characters.")
	}

	@Test("takeLong uploads the text, sends a short body, and keeps mentions and the reply")
	func takeLongUploads() async {
		let uploader = FakeUploader()
		let m = longModel(uploader)
		m.addMention(ChatMention(id: "relay", name: "Relay", kind: .agent))
		m.beginReply(author: "Forge", content: "earlier", serverID: 7)
		let full = String(repeating: "word ", count: 2000)
		m.text = full
		let taken = await m.takeLong()
		let uploaded = await uploader.uploaded
		#expect(uploaded.count == 1)
		#expect(uploaded.first?.hasPrefix("message-") == true && uploaded.first?.hasSuffix(".txt") == true)
		#expect(taken?.text.contains("is attached as \(uploaded[0]).") == true)
		#expect(taken?.text.contains("(9,999 characters)") == true)
		#expect(taken.map { $0.text.count < ChatLimits.maxMessageLength } == true)
		#expect(taken?.metadata?.attachments?.map(\.name) == [uploaded[0]])
		#expect(taken?.metadata?.mentions == ["relay"])
		#expect(taken?.metadata?.quotedMessageId == 7)
		#expect(m.text.isEmpty && m.quote == nil)
	}

	@Test("a failed file upload keeps everything typed and says so")
	func takeLongFails() async {
		let uploader = FakeUploader()
		await uploader.failNext(URLError(.notConnectedToInternet))
		let m = longModel(uploader)
		let full = String(repeating: "x", count: ChatLimits.maxMessageLength + 1)
		m.text = full
		#expect(await m.takeLong() == nil)
		#expect(m.text == full)
		#expect(m.notice?.contains("Couldn't attach the full message") == true)
		#expect(!m.isSplitting)
	}

	@Test("the split: preview is 500 characters cut at a word, the file holds all of it")
	func splitShape() {
		let words = String(repeating: "alpha beta ", count: 1000)
		let split = LongMessageSplit.make(words, now: Date(timeIntervalSince1970: 0))
		#expect(split?.fileName == "message-1970-01-01-00-00-00.txt")
		#expect(split?.fileText == words)
		let preview = split?.body.components(separatedBy: "…").first ?? ""
		#expect(preview.count <= 500 && !preview.hasSuffix(" "))
		#expect(preview.hasSuffix("alpha") || preview.hasSuffix("beta"))
		#expect(
			split?.body.hasSuffix(
				"\n\nThe full message (11,000 characters) is attached as message-1970-01-01-00-00-00.txt.") == true)
		// One word of 600 letters has no space to break on: cut at 500.
		let solid = LongMessageSplit.make(String(repeating: "y", count: 9000))
		#expect(solid?.body.hasPrefix(String(repeating: "y", count: 500) + "…") == true)
		#expect(LongMessageSplit.make(String(repeating: "y", count: ChatLimits.maxMessageLength)) == nil)
		#expect(LongMessageSplit.make(String(repeating: "y", count: ChatLimits.maxMessageLength + 1)) != nil)
	}

	@Test("send is blocked while an attachment uploads and opens when it lands")
	func blocksWhileUploading() async {
		let uploader = FakeUploader()
		await uploader.holdUploads()
		let m = model(uploader)
		m.text = "see attached"
		m.attach(name: "a.png", mimeType: "image/png", prepare: file())
		#expect(m.isUploading)
		#expect(!m.canSend)
		#expect(m.sendBlocker == "Waiting for attachments to upload")
		await uploader.release()
		#expect(await eventually { m.canSend })
		let taken = m.take()
		#expect(taken?.metadata?.attachments?.map(\.fileID) == ["file-1"])
		#expect(taken?.metadata?.attachments?.first?.sizeBytes == 10)
	}

	@Test("a failed upload blocks sending until it is retried or removed")
	func failedUpload() async {
		let uploader = FakeUploader()
		await uploader.failNext(URLError(.notConnectedToInternet))
		let m = model(uploader)
		m.text = "x"
		let id = m.attach(name: "a.png", mimeType: "image/png", prepare: file())!
		#expect(await eventually { m.hasFailedAttachment })
		#expect(!m.canSend)
		m.retryAttachment(id)
		#expect(await eventually { m.canSend })
		#expect(m.attachments.first?.ref?.fileID == "file-1")

		await uploader.failNext(ChatsError("Nope."))
		let second = m.attach(name: "b.png", mimeType: "image/png", prepare: file("b.png"))!
		#expect(await eventually { m.hasFailedAttachment })
		m.removeAttachment(second)
		#expect(m.canSend)
	}

	@Test("a file over the server's size cap fails before uploading")
	func oversize() async {
		let uploader = FakeUploader()
		let m = model(uploader)
		m.attach(name: "big.bin", mimeType: "application/octet-stream", prepare: file("big.bin", bytes: ChatLimits.maxFileBytes + 1))
		#expect(await eventually { m.hasFailedAttachment })
		#expect(await uploader.uploaded.isEmpty)
		if case .failed(let reason)? = m.attachments.first?.state { #expect(reason.contains("10 MB")) }
	}

	@Test("no more than ten attachments")
	func attachmentCap() {
		let m = model()
		for i in 0..<ChatLimits.maxAttachments { #expect(m.attach(name: "f\(i)", mimeType: "image/png", prepare: file()) != nil) }
		#expect(m.attach(name: "extra", mimeType: "image/png", prepare: file()) == nil)
		#expect(m.attachments.count == ChatLimits.maxAttachments)
		#expect(m.notice != nil)
	}

	@Test("take returns text and metadata, then clears everything")
	func takeClears() async {
		let m = model()
		m.text = "  hello @Relay  "
		m.addMention(ChatMention(id: "relay", name: "Relay", kind: .agent))
		let taken = m.take()
		#expect(taken?.text == "hello @Relay")
		#expect(taken?.metadata?.mentions == ["relay"])
		#expect(m.text.isEmpty)
		#expect(m.mentions.isEmpty)
		#expect(m.take() == nil)
	}

	@Test("mentioning yourself never goes on the wire, and a mention isn't added twice")
	func mentionRules() {
		let m = model()
		m.addMention(ChatMention(id: "me", name: "Me", kind: .human))
		m.addMention(ChatMention(id: "relay", name: "Relay", kind: .agent))
		m.addMention(ChatMention(id: "relay", name: "Relay", kind: .agent))
		#expect(m.mentions.map(\.id) == ["relay"])
	}

	@Test("picking a mention removes the @query from the text and adds a chip")
	func pickMention() {
		let m = model()
		m.text = "Can you look @Re"
		m.pick(ChatMention(id: "relay", name: "Relay", kind: .agent))
		#expect(m.text == "Can you look ")
		#expect(m.mentions.map(\.name) == ["Relay"])
		m.text = "@Sa"
		m.pick(ChatMention(id: "sam", name: "Sam", kind: .human))
		#expect(m.text == "")
	}
}

@Suite("MentionTrigger")
struct MentionTriggerTests {
	@Test("finds an @query at the end after whitespace or at the start")
	func finds() {
		#expect(MentionTrigger.find(in: "@")?.query == "")
		#expect(MentionTrigger.find(in: "hi @Re")?.query == "Re")
		#expect(MentionTrigger.find(in: "hi @Relay now") == nil)
	}

	@Test("an @ inside a word (an email) isn't a mention")
	func email() {
		#expect(MentionTrigger.find(in: "mail me@example.com") == nil)
	}

	@Test("candidates: this conversation first, then the workspace; never self, system or already picked")
	func candidates() {
		let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
		let sam = ChatParticipant(id: "sam", name: "Sam", kind: .human)
		let forge = ChatParticipant(id: "forge", name: "Forge", kind: .agent)
		let bot = ChatParticipant(id: "bot", name: "System", kind: .agent)
		let me = ChatParticipant(id: "me", name: "Me", kind: .human)
		let workspace = [
			ChatActor(participant: forge), ChatActor(participant: relay), ChatActor(participant: sam),
			ChatActor(participant: bot, isSystem: true), ChatActor(participant: me),
		]
		let all = MentionTrigger.candidates(
			query: "", participants: [me, relay], workspace: workspace, selfID: "me", excluding: [])
		#expect(all.map(\.id) == ["relay", "forge", "sam"])
		let filtered = MentionTrigger.candidates(
			query: "sa", participants: [me, relay], workspace: workspace, selfID: "me", excluding: [])
		#expect(filtered.map(\.id) == ["sam"])
		let picked = MentionTrigger.candidates(
			query: "", participants: [me, relay], workspace: workspace, selfID: "me", excluding: ["relay"])
		#expect(picked.map(\.id) == ["forge", "sam"])
	}
}

@Suite("DictationText")
struct DictationTextTests {
	@Test("the transcript is appended to what was typed, with one space")
	func merges() {
		#expect(DictationText.merge(base: "", transcript: "hello there") == "hello there")
		#expect(DictationText.merge(base: "Note:", transcript: "buy milk") == "Note: buy milk")
		#expect(DictationText.merge(base: "Note: ", transcript: " buy milk ") == "Note: buy milk")
		#expect(DictationText.merge(base: "Keep this", transcript: "  ") == "Keep this")
	}
}

@Suite("ChatDraftStore", .serialized)
@MainActor
struct ChatDraftStoreTests {
	@Test("keeps unsent text per conversation and forgets blank drafts")
	func perConversation() {
		ChatDraftStore.clearAll()
		ChatDraftStore.set("half a thought", for: "c1")
		ChatDraftStore.set("other", for: "c2")
		#expect(ChatDraftStore.text(for: "c1") == "half a thought")
		#expect(ChatDraftStore.draft(for: "c1") == "half a thought")
		#expect(ChatDraftStore.text(for: "c2") == "other")
		ChatDraftStore.set("   ", for: "c1")
		#expect(ChatDraftStore.text(for: "c1") == "")
		#expect(ChatDraftStore.draft(for: "c1") == nil, "a blank draft reads as no draft for the Team list")
		ChatDraftStore.clearAll()
		#expect(ChatDraftStore.text(for: "c2") == "")
	}

	@Test("a bound composer saves on every keystroke and restores when it binds again")
	func bindSavesAndRestores() {
		ChatDraftStore.clearAll()
		let first = ChatComposerModel(uploader: nil, selfActorID: "me")
		first.bind(conversationID: "c9")
		first.text = "on my w"
		first.text = "on my way"
		#expect(ChatDraftStore.draft(for: "c9") == "on my way")
		#expect(first.boundConversationID == "c9")

		let reopened = ChatComposerModel(uploader: nil, selfActorID: "me")
		reopened.bind(conversationID: "c9")
		#expect(reopened.text == "on my way")
		reopened.text = ""
		#expect(ChatDraftStore.draft(for: "c9") == nil, "an emptied field clears the draft")
		ChatDraftStore.clearAll()
	}

	@Test("text already in the field wins over the stored draft")
	func bindKeepsExistingText() {
		ChatDraftStore.clearAll()
		ChatDraftStore.set("stored", for: "c3")
		let m = ChatComposerModel(uploader: nil, selfActorID: "me")
		m.text = "quoted first"
		m.bind(conversationID: "c3")
		#expect(m.text == "quoted first")
		#expect(ChatDraftStore.draft(for: "c3") == "quoted first")
		ChatDraftStore.clearAll()
	}

	@Test("sending clears the draft, and an edit in progress is not saved as one")
	func sendAndEditDoNotLeak() async {
		ChatDraftStore.clearAll()
		let m = ChatComposerModel(uploader: nil, selfActorID: "me")
		m.bind(conversationID: "c4")
		m.text = "ready"
		_ = m.take()
		#expect(ChatDraftStore.draft(for: "c4") == nil)
		m.text = "typing"
		m.beginEdit(messageID: "1", originalText: "a sent message")
		m.text = "a sent message, edited"
		#expect(ChatDraftStore.draft(for: "c4") == "typing", "the edit text is not the conversation's draft")
		m.clearQuote()
		#expect(m.text == "typing")
		ChatDraftStore.clearAll()
	}

	@Test("an unbound composer never writes a draft")
	func unbound() {
		ChatDraftStore.clearAll()
		let m = ChatComposerModel(uploader: nil, selfActorID: "me")
		m.text = "loose"
		#expect(ChatDraftStore.storage.drafts.isEmpty)
	}
}

@Suite("ComposerLastSlot")
struct ComposerLastSlotTests {
	@Test("empty shows the mic, content shows send, busy and empty shows stop")
	func rule() {
		#expect(ComposerLastSlot.resolve(hasContent: false, busy: false, showsMic: true, showsSend: true) == .mic)
		#expect(ComposerLastSlot.resolve(hasContent: true, busy: false, showsMic: true, showsSend: true) == .send)
		#expect(ComposerLastSlot.resolve(hasContent: false, busy: true, showsMic: true, showsSend: true) == .stop)
		#expect(ComposerLastSlot.resolve(hasContent: true, busy: true, showsMic: true, showsSend: true) == .send, "text wins over stop")
	}

	@Test("a host without a mic or without send collapses the slot")
	func hostOptions() {
		#expect(ComposerLastSlot.resolve(hasContent: false, busy: false, showsMic: false, showsSend: true) == .none)
		#expect(ComposerLastSlot.resolve(hasContent: false, busy: true, showsMic: false, showsSend: true) == .stop)
		#expect(ComposerLastSlot.resolve(hasContent: true, busy: false, showsMic: true, showsSend: false) == .none, "Hold reason: the sheet commits")
		#expect(ComposerLastSlot.resolve(hasContent: false, busy: false, showsMic: true, showsSend: false) == .mic)
	}

	@Test("an attachment alone counts as content")
	@MainActor func attachmentIsContent() async {
		let m = ChatComposerModel(uploader: nil, selfActorID: "me")
		#expect(!m.hasContent)
		m.attach(name: "a.png", mimeType: "image/png") { PreparedChatFile(name: "a.png", mimeType: "image/png", data: Data()) }
		#expect(m.hasContent)
		#expect(!m.canSend, "but the API still needs text")
		m.text = "see this"
		#expect(m.hasContent)
	}
}
