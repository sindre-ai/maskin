import Foundation
import Testing

@testable import MaskinCore

private func session() -> InMemorySecretStore {
	InMemorySecretStore(
		try! JSONEncoder().encode(StoredSession(apiKey: "ank_x", actorId: "a", name: "S", workspaceId: "ws-1")))
}

private final class CredentialsLog: @unchecked Sendable {
	private let lock = NSLock()
	private var _values: [ShareCredentials] = []
	var values: [ShareCredentials] { lock.withLock { _values } }
	func add(_ value: ShareCredentials) { lock.withLock { _values.append(value) } }
}

@Suite("SharePoster chat destination")
struct SharePosterChatTests {
	private let scratch = ShareScratch()

	@Test("uploads the files, then sends one message carrying them, with stable keys")
	func chat() async throws {
		let remote = FakeShareRemote()
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let file = ShareAttachment(
			kind: .pdf, name: "Brief.pdf", mimeType: "application/pdf",
			fileURL: scratch.file("Brief.pdf", bytes: 10), sizeBytes: 10)
		let request = ShareRequest(
			destination: .chat(id: "c-1"), title: "", note: "Thoughts?",
			content: ShareContent(link: URL(string: "https://example.com"), attachments: [file]), status: "")

		let outcome = try await poster.post(request)
		#expect(outcome.conversationID == "c-1")
		#expect(outcome.objectID == nil)
		#expect(
			remote.calls == [
				.upload(name: "Brief.pdf", mime: "application/pdf", key: "base-file-\(file.id.uuidString)"),
				.chat(
					conversation: "c-1", content: "Thoughts?\n\n<https://example.com>", files: ["file-1"],
					key: "base-message"),
			])
	}

	@Test("a retry after a failed send does not upload or message twice")
	func retry() async throws {
		let remote = FakeShareRemote()
		remote.failNext("chat", with: .offline)
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let request = ShareRequest(
			destination: .chat(id: "c-1"), title: "", note: "Hi", content: ShareContent(text: "x"), status: "")
		await #expect(throws: ShareError.offline) { _ = try await poster.post(request) }
		_ = try await poster.post(request)
		#expect(remote.calls.filter { if case .chat = $0 { true } else { false } }.count == 2)
	}

	@Test("a files-only share still gets words: the suggested title")
	func fallbackText() {
		let file = ShareAttachment(
			kind: .image, name: "IMG_2041.jpg", mimeType: "image/jpeg",
			fileURL: URL(fileURLWithPath: "/tmp/x"), sizeBytes: 1)
		#expect(ShareComposer.chatMessage(note: "", content: ShareContent(attachments: [file])) == "IMG_2041")
	}
}

@Suite("ShareSheetModel destinations and queue")
@MainActor
struct ShareSheetModelDestinationTests {
	private let content = ShareContent(link: URL(string: "https://example.com/p")!, linkTitle: "A page")

	@Test("loads the workspace list and conversations, and labels a chat by its title")
	func loadsPickers() async {
		let model = ShareSheetModel(secretStore: session(), loadContent: { content }, makeRemote: { _ in FakeShareRemote() })
		await model.start()
		#expect(model.workspaces.map(\.name) == ["Mesh Firm", "Side Project"])
		#expect(model.conversations.map(\.title) == ["Launch plan"])
		model.destination = .chat(id: "c-1")
		#expect(model.label(for: model.destination) == "Launch plan")
		#expect(!model.showsTitleField)
	}

	@Test("choosing another workspace rebuilds the remote for it")
	func selectsWorkspace() async {
		let log = CredentialsLog()
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { content },
			makeRemote: { log.add($0); return FakeShareRemote() })
		await model.start()
		await model.selectWorkspace("ws-2")
		#expect(model.activeWorkspaceId == "ws-2")
		#expect(log.values.last == ShareCredentials(apiKey: "ank_x", workspaceId: "ws-2"))
	}

	@Test("switching workspace leaves a chat destination, which belongs to the old one")
	func workspaceResetsChat() async {
		let model = ShareSheetModel(secretStore: session(), loadContent: { content }, makeRemote: { _ in FakeShareRemote() })
		await model.start()
		model.destination = .chat(id: "c-1")
		await model.selectWorkspace("ws-2")
		#expect(model.destination == .object(type: "insight"))
	}

	@Test("an offline post is parked for the app and the sheet says so")
	func parksOffline() async throws {
		let scratch = ShareScratch()
		let queue = ShareQueue(root: scratch.url.appendingPathComponent("queue"))
		let remote = FakeShareRemote()
		remote.failNext("object", with: .offline)
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { content }, makeRemote: { _ in remote }, queue: queue)
		await model.start()
		await model.post()
		#expect(model.phase == .queued)
		let parked = try #require(queue.pending().first)
		#expect(parked.workspaceId == "ws-1")
		#expect(parked.title == "A page")
	}

	@Test("with no queue the offline failure stays on screen and the draft is kept")
	func noQueue() async {
		let remote = FakeShareRemote()
		remote.failNext("object", with: .offline)
		let model = ShareSheetModel(secretStore: session(), loadContent: { content }, makeRemote: { _ in remote })
		await model.start()
		await model.post()
		#expect(model.phase == .failed(.offline))
	}

	@Test("a refused share is not parked")
	func rejectedNotParked() async {
		let scratch = ShareScratch()
		let queue = ShareQueue(root: scratch.url.appendingPathComponent("queue"))
		let remote = FakeShareRemote()
		remote.failNext("object", with: .rejected)
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { content }, makeRemote: { _ in remote }, queue: queue)
		await model.start()
		await model.post()
		#expect(model.phase == .failed(.rejected))
		#expect(queue.pending().isEmpty)
	}
}
