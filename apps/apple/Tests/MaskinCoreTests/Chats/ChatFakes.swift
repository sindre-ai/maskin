import Foundation
import MaskinAPI

@testable import MaskinCore

let chatT0 = Date(timeIntervalSince1970: 1_790_000_000)

func chatMsg(
	_ id: Int, by actor: String = "me", name: String? = nil, agent: Bool = false,
	_ text: String = "hi", at offset: TimeInterval? = nil, metadata: JSONValue? = nil
) -> ChatMessage {
	.confirmed(
		serverID: id, conversationID: "c1", actorID: actor, actorName: name ?? actor,
		author: agent ? .agent : .human, content: text,
		createdAt: chatT0.addingTimeInterval(offset ?? TimeInterval(id)), metadata: metadata)
}

let chatMe = ChatParticipant(id: "me", name: "Me", kind: .human)
let chatRelay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
let chatSam = ChatParticipant(id: "sam", name: "Sam", kind: .human)

func chatConvo(
	_ id: String, title: String? = nil, last: Date? = chatT0, pinned: Bool = false, unread: Int = 0,
	snippet: String? = nil, participants: [ChatParticipant] = [chatMe, chatRelay], lastRead: Int? = nil
) -> ConversationSummary {
	ConversationSummary(
		id: id, title: title ?? "Chat \(id)", lastMessageAt: last, createdAt: last, pinned: pinned,
		unreadCount: unread, snippet: snippet, participants: participants, lastReadMessageID: lastRead)
}

/// Server-side thread. `messages` are all server rows; `send` appends one.
actor FakeChatAPI: ChatAPI {
	var server: [ChatMessage]
	var detailValue: ConversationSummary
	var sendErrors: [any Error] = []
	var sentKeys: [String] = []
	var sentContents: [String] = []
	var sentMetadata: [ChatSendMetadata?] = []
	var sessionList: [ChatAgentSession] = []
	var stopped: [String] = []
	var resumed: [String] = []
	var removed: [String] = []
	var renamed: [String] = []
	var edits: [(Int, String)] = []
	var detailCalls = 0
	var failMutations = false
	var failMessages = false
	/// Persist the next N sends, then fail as if the response was lost on the way back.
	var loseResponses = 0
	var readCalls: [Int] = []
	var retried: [(Int, String?)] = []
	var actorList: [ChatActor] = []
	var messageCalls: [(before: Int?, after: Int?)] = []
	var afterSend: (@Sendable () async -> Void)?
	var persistedByKey: [String: ChatMessage] = [:]

	init(server: [ChatMessage] = [], detail: ConversationSummary = chatConvo("c1")) {
		self.server = server
		self.detailValue = detail
	}

	func set(server: [ChatMessage]) { self.server = server }
	func append(_ m: ChatMessage) { server.append(m) }
	func replace(_ m: ChatMessage) {
		if let i = server.firstIndex(where: { $0.serverID == m.serverID }) { server[i] = m }
	}
	func failNextSends(_ errors: [any Error]) { sendErrors = errors }
	func setLoseResponses(_ n: Int) { loseResponses = n }
	func setFailMessages(_ v: Bool) { failMessages = v }
	func setFailMutations(_ v: Bool) { failMutations = v }
	func setSessions(_ s: [ChatAgentSession]) { sessionList = s }
	func setActors(_ a: [ChatActor]) { actorList = a }
	func setAfterSend(_ f: (@Sendable () async -> Void)?) { afterSend = f }

	func detail(conversationID: String) async throws -> ConversationSummary {
		detailCalls += 1
		return detailValue
	}

	func messages(conversationID: String, beforeID: Int?, afterID: Int?, limit: Int) async throws
		-> MessagePage
	{
		messageCalls.append((beforeID, afterID))
		if failMessages { throw URLError(.notConnectedToInternet) }
		var rows = server.sorted { ($0.serverID ?? 0) > ($1.serverID ?? 0) }
		if let beforeID { rows = rows.filter { ($0.serverID ?? 0) < beforeID } }
		if let afterID { rows = rows.filter { ($0.serverID ?? 0) > afterID } }
		let page = Array(rows.prefix(limit))
		return MessagePage(messages: page.reversed(), hasMore: rows.count > limit)
	}

	func send(
		conversationID: String, content: String, metadata: ChatSendMetadata?, idempotencyKey: String
	) async throws -> ChatMessage {
		sentKeys.append(idempotencyKey)
		sentContents.append(content)
		sentMetadata.append(metadata)
		if !sendErrors.isEmpty { throw sendErrors.removeFirst() }
		// Idempotent like the real backend: the same key returns the row it already made.
		if let existing = persistedByKey[idempotencyKey] { return existing }
		let next = (server.compactMap(\.serverID).max() ?? 0) + 1
		let saved = chatMsg(next, by: "me", content, at: 1000 + TimeInterval(next), metadata: metadata?.jsonValue)
		server.append(saved)
		persistedByKey[idempotencyKey] = saved
		if loseResponses > 0 {
			loseResponses -= 1
			throw URLError(.networkConnectionLost)
		}
		if let afterSend { await afterSend() }
		return saved
	}

	func sessions(conversationID: String) async throws -> [ChatAgentSession] { sessionList }
	func stopSession(sessionID: String) async throws { stopped.append(sessionID) }
	func resumeSession(sessionID: String) async throws { resumed.append(sessionID) }
	func removeParticipant(conversationID: String, actorID: String) async throws {
		if failMutations { throw ChatsError("nope") }
		removed.append(actorID)
	}
	func rename(conversationID: String, title: String) async throws {
		if failMutations { throw ChatsError("nope") }
		renamed.append(title)
	}

	func retry(conversationID: String, messageID: Int, agentID: String?) async throws {
		retried.append((messageID, agentID))
	}

	func edit(conversationID: String, messageID: Int, content: String) async throws -> ChatMessage {
		if failMutations { throw ChatsError("Only the author can edit a message.") }
		edits.append((messageID, content))
		guard let index = server.firstIndex(where: { $0.serverID == messageID }) else {
			throw ChatsError("That message no longer exists.")
		}
		server[index].content = content
		server[index].editedAt = chatT0.addingTimeInterval(500)
		return server[index]
	}

	func markRead(conversationID: String, lastMessageID: Int) async throws {
		readCalls.append(lastMessageID)
	}

	func addParticipants(conversationID: String, actorIDs: [String]) async throws {}
	func actors() async throws -> [ChatActor] { actorList }
}

actor FakeListAPI: ConversationsAPI {
	var pages: [ConversationSummary]
	var failState = false
	var failList = false
	var stateCalls: [String] = []
	var listCalls = 0
	var listLimits: [Int] = []
	var created: [(String, [String], String?)] = []

	init(_ items: [ConversationSummary]) { pages = items }
	func set(_ items: [ConversationSummary]) { pages = items }
	func setFailState(_ v: Bool) { failState = v }
	func setFailList(_ v: Bool) { failList = v }

	var listFilters: [String] = []

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws
		-> ConversationPage
	{
		if failList { throw URLError(.notConnectedToInternet) }
		listFilters.append("pinned=\(pinnedOnly) unread=\(unreadOnly)")
		listCalls += 1
		listLimits.append(limit)
		if limit > ServerLimits.maxPageSize { throw ChatsError("400: limit above server max") }
		let slice = Array(pages.dropFirst(offset).prefix(limit))
		return ConversationPage(conversations: slice, hasMore: offset + limit < pages.count)
	}

	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String)
		async throws -> ConversationSummary
	{
		created.append((title, participantIDs, initialMessage))
		return chatConvo("new", title: title, participants: [chatMe])
	}

	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool
	) async throws {
		if failState { throw ChatsError("nope") }
		stateCalls.append(
			"\(conversationID) pinned=\(pinned.map(String.init) ?? "-") archived=\(archived.map(String.init) ?? "-") read=\(lastReadMessageID.map(String.init) ?? "-") unread=\(markUnread)"
		)
	}

	func actors() async throws -> [ChatActor] { [ChatActor(participant: chatRelay)] }
}

/// A hub fed by scripted SSE bodies; each open() takes the next body, then holds open.
actor SSEScript {
	var bodies: [String]
	init(_ bodies: [String]) { self.bodies = bodies }
	func next() -> String? { bodies.isEmpty ? nil : bodies.removeFirst() }
}

func conversationFrame(_ id: Int, conversation: String, action: String = "message_posted", entity: String = "conversation") -> String {
	let json =
		#"{"workspace_id":"w1","actor_id":"a","action":"\#(action)","entity_type":"\#(entity)","entity_id":"\#(conversation)","event_id":"\#(id)"}"#
	return "id: \(id)\nevent: \(action)\ndata: \(json)\n\n"
}

@MainActor
func scriptedHub(_ bodies: [String]) -> EventHub {
	let script = SSEScript(bodies)
	let client = SSEClient(
		open: { _ in
			let body = await script.next()
			return AsyncThrowingStream { c in
				if let body { for b in body.utf8 { c.yield(b) } }
				if body != nil { c.finish() }
			}
		},
		backoff: SSEBackoff(initial: .milliseconds(1), max: .milliseconds(2)),
		silenceTimeout: .seconds(30))
	return EventHub(client: client)
}

/// Poll until `condition` holds (or fail after ~2s).
@MainActor
func eventually(_ condition: @MainActor () async -> Bool) async -> Bool {
	for _ in 0..<200 {
		if await condition() { return true }
		try? await Task.sleep(for: .milliseconds(10))
	}
	return false
}


/// Everything a thread test needs: a real outbox (temp file, manual network) + queue + store over
/// the fake API, wired the way `ChatsRuntime` wires them.
@MainActor
final class ChatHarness {
	let api: FakeChatAPI
	let network: ManualNetworkMonitor
	let outbox: Outbox
	let queue: ChatSendQueue
	let store: ChatStore
	let file: URL

	init(
		server: [ChatMessage] = [], detail: ConversationSummary = chatConvo("c1"), online: Bool = true,
		events: EventHub? = nil, file: URL? = nil, pageSize: Int = 50, failedFile: URL? = nil,
		api existing: FakeChatAPI? = nil
	) {
		let api = existing ?? FakeChatAPI(server: server, detail: detail)
		self.api = api
		network = ManualNetworkMonitor(isOnline: online)
		self.file = file ?? temporaryOutboxFile()
		let box = HarnessBox()
		let executor = ChatSendExecutor(
			api: api,
			onDelivered: { clientID, message in
				await MainActor.run { box.queue?.recordDelivery(clientID: clientID, message: message) }
			})
		outbox = Outbox(
			fileURL: self.file, executor: executor, network: network, workspaceId: { "w1" },
			backoff: { _ in 0.02 })
		queue = ChatSendQueue(outbox: outbox, failedFileURL: failedFile)
		box.queue = queue
		queue.start()
		outbox.start()
		store = ChatStore(
			conversationID: "c1", currentActorID: "me", currentActorName: "Me", api: api, queue: queue,
			events: events, pageSize: pageSize, pollInterval: nil, now: { chatT0 })
	}

	/// Wait until nothing is queued any more.
	func settled() async -> Bool {
		await eventually { () async -> Bool in self.outbox.entries.isEmpty }
	}

	private final class HarnessBox: @unchecked Sendable {
		@MainActor var queue: ChatSendQueue?
	}
}
