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

@Suite("ChatDraftStore")
@MainActor
struct ChatDraftStoreTests {
	@Test("keeps unsent text per conversation and forgets blank drafts")
	func perConversation() {
		ChatDraftStore.clearAll()
		ChatDraftStore.set("half a thought", for: "c1")
		ChatDraftStore.set("other", for: "c2")
		#expect(ChatDraftStore.text(for: "c1") == "half a thought")
		#expect(ChatDraftStore.text(for: "c2") == "other")
		ChatDraftStore.set("   ", for: "c1")
		#expect(ChatDraftStore.text(for: "c1") == "")
		ChatDraftStore.clearAll()
		#expect(ChatDraftStore.text(for: "c2") == "")
	}
}
