import Foundation
import Testing

@testable import MaskinCore

private func session(workspace: String = "ws-1") -> InMemorySecretStore {
	InMemorySecretStore(
		try! JSONEncoder().encode(StoredSession(apiKey: "ank_x", actorId: "a", name: "S", workspaceId: workspace)))
}

private func memory() -> ShareAgentMemory {
	ShareAgentMemory(defaults: UserDefaults(suiteName: "share-memory-\(UUID().uuidString)")!)
}

@Suite("SharePoster new chat")
struct SharePosterNewChatTests {
	private let scratch = ShareScratch()

	@Test("uploads the files first, then starts the chat in one call under its own key")
	func newChat() async throws {
		let remote = FakeShareRemote()
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let file = ShareAttachment(
			kind: .pdf, name: "Brief.pdf", mimeType: "application/pdf",
			fileURL: scratch.file("Brief.pdf", bytes: 10), sizeBytes: 10)
		let request = ShareRequest(
			destination: .newChat(agentID: "agent-cpo"), title: "A page", note: "Thoughts?",
			content: ShareContent(link: URL(string: "https://example.com"), attachments: [file]), status: "")

		let outcome = try await poster.post(request)
		#expect(outcome.conversationID == "chat-2")
		#expect(outcome.objectID == nil)
		#expect(
			remote.calls == [
				.upload(name: "Brief.pdf", mime: "application/pdf", key: "base-file-\(file.id.uuidString)"),
				.createChat(
					agent: "agent-cpo", title: "A page", content: "Thoughts?\n\n<https://example.com>",
					files: ["file-1"], key: "share-chat-base"),
			])
	}

	@Test("a retry after a failed start reuses the upload and the key, so no second chat can begin")
	func retry() async throws {
		let remote = FakeShareRemote()
		remote.failNext("createChat", with: .server)
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let file = ShareAttachment(
			kind: .pdf, name: "a.pdf", mimeType: "application/pdf", fileURL: scratch.file("a.pdf", bytes: 10),
			sizeBytes: 10)
		let request = ShareRequest(
			destination: .newChat(agentID: "agent-cpo"), title: "", note: "Hi",
			content: ShareContent(text: "x", attachments: [file]), status: "")
		await #expect(throws: ShareError.server) { _ = try await poster.post(request) }
		_ = try await poster.post(request)
		let uploads = remote.calls.filter { if case .upload = $0 { true } else { false } }
		let keys = remote.calls.compactMap { call -> String? in
			if case .createChat(_, _, _, _, let key) = call { key } else { nil }
		}
		#expect(uploads.count == 1)
		#expect(keys == ["share-chat-base", "share-chat-base"])
	}

	@Test("a finished share does not start a second chat when posted again")
	func notTwice() async throws {
		let remote = FakeShareRemote()
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let request = ShareRequest(
			destination: .newChat(agentID: "agent-cpo"), title: "", note: "", content: ShareContent(text: "x"),
			status: "")
		_ = try await poster.post(request)
		_ = try await poster.post(request)
		#expect(remote.calls.filter { if case .createChat = $0 { true } else { false } }.count == 1)
	}

	@Test("the chat is titled with the share, else the app's default new-chat title")
	func title() {
		let page = ShareContent(link: URL(string: "https://example.com"), linkTitle: "A page")
		#expect(ShareComposer.chatTitle("", content: page) == "A page")
		#expect(ShareComposer.chatTitle("Mine", content: page) == "Mine")
		#expect(ShareComposer.chatTitle("", content: ShareContent(text: "  \n")) == "New chat")
	}
}

@Suite("ShareSheetModel new chat")
@MainActor
struct ShareSheetModelNewChatTests {
	private let link = ShareContent(link: URL(string: "https://example.com/p")!, linkTitle: "A page")

	private func started(
		remote: FakeShareRemote = FakeShareRemote(), memory: ShareAgentMemory? = nil, queue: ShareQueue? = nil
	) async -> ShareSheetModel {
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in remote }, queue: queue,
			memory: memory)
		await model.start()
		return model
	}

	@Test("the Chief of Staff is the first agent, and Send is on once the agents are loaded")
	func chiefFirst() async {
		let model = await started()
		#expect(model.selectedAgent?.name == "Chief of Staff")
		#expect(model.isNewChat && model.canPost && !model.showsTitleField)
		#expect(model.successTitle == "Chat started with Chief of Staff")
	}

	@Test("the last agent used in this workspace comes first, and is written when Send is tapped")
	func remembersLastAgent() async {
		let store = memory()
		store.remember("agent-researcher", workspaceId: "ws-1")
		let model = await started(memory: store)
		#expect(model.selectedAgent?.id == "agent-researcher")
		model.selectAgent("agent-cpo")
		await model.post()
		#expect(store.recent(workspaceId: "ws-1") == ["agent-cpo", "agent-researcher"])
		#expect(model.recentAgents.map(\.id) == ["agent-cpo", "agent-researcher"])
	}

	@Test("one value per workspace: another workspace's last agent is not used here")
	func memoryPerWorkspace() {
		let store = memory()
		store.remember("agent-cpo", workspaceId: "ws-2")
		#expect(store.recent(workspaceId: "ws-1").isEmpty)
		store.remember("a", workspaceId: "ws-1")
		store.remember("b", workspaceId: "ws-1")
		store.remember("c", workspaceId: "ws-1")
		#expect(store.recent(workspaceId: "ws-1") == ["c", "b"])
	}

	@Test("a last agent that left the workspace falls back to the Chief of Staff")
	func staleMemory() async {
		let store = memory()
		store.remember("gone", workspaceId: "ws-1")
		let model = await started(memory: store)
		#expect(model.selectedAgent?.name == "Chief of Staff")
	}

	@Test("a workspace with no Chief of Staff starts empty and Send is off until an agent is picked")
	func noChief() async {
		let remote = FakeShareRemote()
		remote.agentsResult = .success([ShareAgent(id: "agent-cpo", name: "CPO")])
		let model = await started(remote: remote)
		#expect(model.selectedAgent == nil)
		#expect(!model.canPost)
		model.selectAgent("agent-cpo")
		#expect(model.canPost)
	}

	@Test("a workspace with no agents blocks with its own message")
	func noAgents() async {
		let remote = FakeShareRemote()
		remote.agentsResult = .success([])
		let model = await started(remote: remote)
		#expect(model.phase == .blocked(.noAgents))
	}

	@Test("search matches the name or the role")
	func search() async {
		let model = await started()
		#expect(model.agents(matching: "").count == 3)
		#expect(model.agents(matching: "research").map(\.name) == ["Researcher"])
		#expect(model.agents(matching: "product").map(\.name) == ["CPO"])
		#expect(model.agents(matching: "zzz").isEmpty)
	}

	@Test("Send starts a chat with the picked agent and Open in Maskin goes to that chat")
	func sendStartsChat() async {
		let remote = FakeShareRemote()
		let model = await started(remote: remote)
		model.selectAgent("agent-researcher")
		model.note = "Find the sources"
		await model.post()
		guard case .posted(let outcome) = model.phase else {
			Issue.record("expected posted, got \(model.phase)")
			return
		}
		#expect(outcome.conversationID == "chat-1")
		#expect(model.openURL?.absoluteString == "maskin://ws-1/chats/chat-1")
		#expect(model.successTitle == "Chat started with Researcher")
		let created = remote.calls.compactMap { call -> (String, String, String)? in
			if case .createChat(let agent, let title, let content, _, _) = call { (agent, title, content) } else { nil }
		}
		#expect(created.count == 1)
		#expect(created.first?.0 == "agent-researcher")
		#expect(created.first?.1 == "A page")
		#expect(created.first?.2 == "Find the sources\n\n[A page](https://example.com/p)")
	}

	@Test("an existing chat is still a choice, and it adds a message instead of starting a chat")
	func existingChat() async {
		let remote = FakeShareRemote()
		let model = await started(remote: remote)
		model.selectConversation("c-1")
		#expect(!model.isNewChat)
		#expect(model.successTitle == "Sent to Launch plan")
		await model.post()
		#expect(remote.calls.contains { if case .chat(let id, _, _, _) = $0 { id == "c-1" } else { false } })
		#expect(!remote.calls.contains { if case .createChat = $0 { true } else { false } })
	}

	@Test("a server hiccup parks the share with its agent, it is not lost")
	func hiccupIsParked() async throws {
		let scratch = ShareScratch()
		let queue = ShareQueue(root: scratch.url.appendingPathComponent("queue"))
		let remote = FakeShareRemote()
		remote.failNext("createChat", with: .server)
		let model = await started(remote: remote, queue: queue)
		model.selectAgent("agent-cpo")
		await model.post()
		#expect(model.phase == .queued)
		let parked = try #require(queue.pending().first)
		#expect(parked.destination.destination == .newChat(agentID: "agent-cpo"))
	}

	@Test("a refused chat is shown as failed and kept on screen, not parked and not dropped")
	func refusedStaysOnScreen() async {
		let scratch = ShareScratch()
		let queue = ShareQueue(root: scratch.url.appendingPathComponent("queue"))
		let remote = FakeShareRemote()
		remote.failNext("createChat", with: .rejected)
		let model = await started(remote: remote, queue: queue)
		model.note = "keep me"
		await model.post()
		#expect(model.phase == .failed(.rejected))
		#expect(model.note == "keep me")
		#expect(queue.pending().isEmpty)
	}

	@Test("offline with no agent list: the last agent used is the target and the share is saved for later")
	func offlineUsesLastAgent() async throws {
		let scratch = ShareScratch()
		let queue = ShareQueue(root: scratch.url.appendingPathComponent("queue"))
		let store = memory()
		store.remember("agent-researcher", workspaceId: "ws-1")
		let remote = FakeShareRemote()
		remote.agentsResult = .failure(.offline)
		remote.failNext("createChat", with: .offline)
		let model = await started(remote: remote, memory: store, queue: queue)
		#expect(model.agentsFailedToLoad && model.canPost)
		await model.post()
		#expect(model.phase == .queued)
		#expect(try #require(queue.pending().first).destination.destination == .newChat(agentID: "agent-researcher"))
	}

	@Test("offline with no agent list and no last agent: Send fails instead of saving a share with no target")
	func offlineWithoutAgent() async {
		let remote = FakeShareRemote()
		remote.agentsResult = .failure(.offline)
		let model = await started(remote: remote)
		await model.post()
		#expect(model.phase == .failed(.offline))
		#expect(!remote.calls.contains { if case .createChat = $0 { true } else { false } })
	}

	@Test("a failed post that already uploaded files says so, for the Retry hint")
	func uploadedBeforeFailure() async {
		let scratch = ShareScratch()
		let file = ShareAttachment(
			kind: .pdf, name: "a.pdf", mimeType: "application/pdf", fileURL: scratch.file("a.pdf", bytes: 10),
			sizeBytes: 10)
		let remote = FakeShareRemote()
		remote.failNext("createChat", with: .rejected)
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { ShareContent(attachments: [file]) }, makeRemote: { _ in remote })
		await model.start()
		await model.post()
		#expect(model.phase == .failed(.rejected))
		#expect(model.uploadedFilesBeforeFailure)
	}

	@Test("a parked new-chat share reads back with its agent and drains by starting the chat once")
	func drains() async throws {
		let scratch = ShareScratch()
		let queue = ShareQueue(root: scratch.url.appendingPathComponent("queue"))
		let request = ShareRequest(
			destination: .newChat(agentID: "agent-cpo"), title: "T", note: "n", content: ShareContent(text: "x"),
			status: "")
		try queue.enqueue(request, workspaceId: "ws-1", idempotencyBase: "base")
		let remote = FakeShareRemote()
		let drainer = ShareQueueDrainer(queue: queue, makeRemote: { _ in remote })
		let report = await drainer.drain(apiKey: "ank_x")
		#expect(report.sent == 1 && report.remaining == 0)
		let keys = remote.calls.compactMap { call -> String? in
			if case .createChat(_, _, _, _, let key) = call { key } else { nil }
		}
		#expect(keys == ["share-chat-base"])
	}
}
