import Foundation
import Testing

@testable import MaskinCore

@MainActor
private final class Identity {
	var actor: String? = "actor-a"
	var workspace: String? = "ws-1"
}

/// One fake server per conversation id.
private actor MultiChatAPI: ChatAPI {
	var threads: [String: FakeChatAPI]
	var fetched: [String] = []
	var gate: (@Sendable () async -> Void)?

	init(_ threads: [String: FakeChatAPI]) { self.threads = threads }
	func setGate(_ f: (@Sendable () async -> Void)?) { gate = f }

	func detail(conversationID: String) async throws -> ConversationSummary {
		try await threads[conversationID]!.detail(conversationID: conversationID)
	}
	func messages(conversationID: String, beforeID: Int?, afterID: Int?, limit: Int) async throws
		-> MessagePage
	{
		fetched.append(conversationID)
		if let gate { await gate() }
		return try await threads[conversationID]!.messages(
			conversationID: conversationID, beforeID: beforeID, afterID: afterID, limit: limit)
	}
	func send(conversationID: String, content: String, metadata: ChatSendMetadata?, idempotencyKey: String)
		async throws -> ChatMessage { throw ChatsError("no") }
	func retry(conversationID: String, messageID: Int, agentID: String?) async throws {}
	func markRead(conversationID: String, lastMessageID: Int) async throws { throw ChatsError("must not mark read") }
	func edit(conversationID: String, messageID: Int, content: String) async throws -> ChatMessage {
		throw ChatsError("no")
	}
	func addParticipants(conversationID: String, actorIDs: [String]) async throws {}
	func actors() async throws -> [ChatActor] { [] }
}

@MainActor
private struct Rig {
	let directory = FileManager.default.temporaryDirectory.appendingPathComponent("prefetch-\(UUID().uuidString)")
	let disk: DiskCache
	let identity = Identity()
	init() { disk = DiskCache(directory: directory) }
	var cache: SnapshotCache {
		let identity = identity
		return SnapshotCache(disk: disk, actorId: { identity.actor }, workspaceId: { identity.workspace })
	}
	func cleanUp() { try? FileManager.default.removeItem(at: directory) }

	/// A snapshot whose newest message is `id`, as `ChatStore` writes it.
	func seed(_ conversation: String, newest id: Int) {
		var rows: [ChatMessage] = []
		for i in 1...id {
			var m = chatMsg(i, "m\(i)")
			m.conversationID = conversation
			rows.append(m)
		}
		cache.write(
			ChatCaching.ThreadSnapshot(
				detail: chatConvo(conversation), messages: rows.compactMap(ChatCaching.CachedMessage.init)),
			ChatCaching.threadName(conversation), version: ChatCaching.version)
	}

	func snapshot(_ conversation: String) -> ChatCaching.ThreadSnapshot? {
		cache.read(ChatCaching.ThreadSnapshot.self, ChatCaching.threadName(conversation), version: ChatCaching.version)?.value
	}
}

private func server(_ id: String, count: Int, last: Date) -> FakeChatAPI {
	var rows: [ChatMessage] = []
	for i in 1...count {
		var m = chatMsg(i, "m\(i)", at: last.timeIntervalSince(chatT0) - TimeInterval(count - i))
		m.conversationID = id
		rows.append(m)
	}
	return FakeChatAPI(server: rows, detail: chatConvo(id, last: last))
}

private let newer = chatT0.addingTimeInterval(600)

@Suite("Thread prefetch")
@MainActor
struct ThreadPrefetcherTests {
	@Test("picks the newest unread chats first, up to the limit, and skips archived")
	func selectsTopUnread() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		var list: [ConversationSummary] = []
		var threads: [String: FakeChatAPI] = [:]
		for i in 1...8 {
			let id = "c\(i)"
			list.append(chatConvo(id, last: newer.addingTimeInterval(TimeInterval(-i)), unread: 1))
			threads[id] = server(id, count: 3, last: newer.addingTimeInterval(TimeInterval(-i)))
			rig.seed(id, newest: 2)
		}
		list[0].archived = true
		let api = MultiChatAPI(threads)
		let prefetcher = ThreadPrefetcher(api: api, cache: rig.cache, limit: 3, debounce: .zero)
		prefetcher.listChanged(list)
		await prefetcher.runPass()
		let fetched = await api.fetched
		#expect(Set(fetched) == ["c2", "c3", "c4"])
	}

	@Test("skips chats whose cache already holds the newest message")
	func skipsUpToDate() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let last = chatT0.addingTimeInterval(3)
		let api = MultiChatAPI(["c1": server("c1", count: 3, last: last)])
		rig.seed("c1", newest: 3)
		let prefetcher = ThreadPrefetcher(api: api, cache: rig.cache, debounce: .zero)
		prefetcher.listChanged([chatConvo("c1", last: last, unread: 1)])
		await prefetcher.runPass()
		#expect(await api.fetched.isEmpty)
	}

	@Test("an unread chat with nothing cached is fetched; a read one with nothing cached is not")
	func missingSnapshot() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let api = MultiChatAPI([
			"unread": server("unread", count: 2, last: newer), "read": server("read", count: 2, last: newer),
		])
		let prefetcher = ThreadPrefetcher(api: api, cache: rig.cache, debounce: .zero)
		prefetcher.listChanged([chatConvo("unread", last: newer, unread: 2), chatConvo("read", last: newer)])
		await prefetcher.runPass()
		#expect(await api.fetched == ["unread"])
		#expect(rig.snapshot("unread")?.messages.count == 2)
		#expect(rig.snapshot("read") == nil)
	}

	@Test("never marks anything read")
	func neverMarksRead() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let thread = server("c1", count: 3, last: newer)
		let prefetcher = ThreadPrefetcher(
			api: MultiChatAPI(["c1": thread]), cache: rig.cache, debounce: .zero)
		rig.seed("c1", newest: 2)
		prefetcher.listChanged([chatConvo("c1", last: newer, unread: 1)])
		await prefetcher.runPass()
		#expect(await thread.readCalls.isEmpty)
	}

	@Test("one in-flight fetch per conversation")
	func dedupesInFlight() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let api = MultiChatAPI(["c1": server("c1", count: 3, last: newer)])
		rig.seed("c1", newest: 2)
		let release = AsyncGate()
		await api.setGate { await release.wait() }
		let prefetcher = ThreadPrefetcher(api: api, cache: rig.cache, debounce: .zero)
		prefetcher.listChanged([chatConvo("c1", last: newer, unread: 1)])
		async let first: Void = prefetcher.runPass()
		await Task.yield()
		try? await Task.sleep(for: .milliseconds(50))
		await prefetcher.runPass()
		await release.open()
		await first
		#expect(await api.fetched == ["c1"])
	}

	@Test("a workspace switch cancels in-flight fetches and nothing is written")
	func cancelOnSwitch() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let api = MultiChatAPI(["c1": server("c1", count: 3, last: newer)])
		rig.seed("c1", newest: 2)
		let release = AsyncGate()
		await api.setGate { await release.wait() }
		let prefetcher = ThreadPrefetcher(api: api, cache: rig.cache, debounce: .zero)
		prefetcher.listChanged([chatConvo("c1", last: newer, unread: 1)])
		async let pass: Void = prefetcher.runPass()
		try? await Task.sleep(for: .milliseconds(50))
		prefetcher.cancelAll()
		await release.open()
		await pass
		#expect(rig.snapshot("c1")?.messages.count == 2, "the old snapshot is untouched")
	}

	@Test("a prefetched snapshot is what a new ChatStore paints before any network call")
	func hydrateReadsPrefetched() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let thread = server("c1", count: 4, last: newer)
		rig.seed("c1", newest: 2)
		let prefetcher = ThreadPrefetcher(
			api: MultiChatAPI(["c1": thread]), cache: rig.cache, debounce: .zero)
		prefetcher.listChanged([chatConvo("c1", last: newer, unread: 2)])
		await prefetcher.runPass()

		let calls = FakeChatAPI(server: [])
		let store = makeStore(rig, api: calls, known: newer)
		#expect(store.messages.compactMap(\.serverID) == [1, 2, 3, 4])
		#expect(store.isCatchingUp == false)
		#expect(await calls.messageCalls.isEmpty)
	}

	@Test("a write never moves a snapshot backwards")
	func neverRegresses() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		rig.seed("c1", newest: 5)
		let prefetcher = ThreadPrefetcher(
			api: MultiChatAPI(["c1": server("c1", count: 3, last: newer)]), cache: rig.cache, debounce: .zero)
		prefetcher.listChanged([chatConvo("c1", last: newer, unread: 1)])
		await prefetcher.runPass()
		#expect(rig.snapshot("c1")?.messages.last?.serverID == 5)
	}
}

@Suite("Thread opens fresh")
@MainActor
struct ThreadFirstPaintTests {
	@Test("with a prefetched snapshot, the newest message is on screen before the network answers")
	func prefetchedPaintsFirst() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let thread = server("c1", count: 4, last: newer)
		rig.seed("c1", newest: 2)
		let prefetcher = ThreadPrefetcher(
			api: MultiChatAPI(["c1": thread]), cache: rig.cache, debounce: .zero)
		prefetcher.listChanged([chatConvo("c1", last: newer, unread: 2)])
		await prefetcher.runPass()

		let api = server("c1", count: 4, last: newer)
		let store = makeStore(rig, api: api, known: newer)
		let seen = Seen()
		await api.setMessagesGate { await MainActor.run { seen.ids = store.messages.compactMap(\.serverID) } }
		await store.load()
		#expect(seen.ids == [1, 2, 3, 4], "newest was already painted when the request was in flight")
	}

	@Test("without a prefetch, the stale page shows the catching-up flag until the merge lands")
	func staleShowsCatchingUp() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		rig.seed("c1", newest: 2)
		let api = server("c1", count: 4, last: newer)
		let store = makeStore(rig, api: api, known: newer)
		#expect(store.messages.compactMap(\.serverID) == [1, 2])
		#expect(store.isCatchingUp)
		let seen = Seen()
		await api.setMessagesGate { await MainActor.run { seen.catchingUp = store.isCatchingUp } }
		await store.load()
		#expect(seen.catchingUp, "still catching up while the request is in flight")
		#expect(store.isCatchingUp == false)
		#expect(store.messages.compactMap(\.serverID) == [1, 2, 3, 4])
	}

	@Test("the flag clears when the load fails")
	func clearsOnFailure() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		rig.seed("c1", newest: 2)
		let api = server("c1", count: 4, last: newer)
		await api.setFailMessages(true)
		let store = makeStore(rig, api: api, known: newer)
		#expect(store.isCatchingUp)
		await store.load()
		#expect(store.isCatchingUp == false)
	}

	@Test("an up-to-date cache never shows the flag")
	func upToDate() {
		let rig = Rig()
		defer { rig.cleanUp() }
		rig.seed("c1", newest: 3)
		let store = makeStore(rig, api: FakeChatAPI(), known: chatT0.addingTimeInterval(3))
		#expect(store.isCatchingUp == false)
	}
}

@MainActor
private final class Seen {
	var ids: [Int] = []
	var catchingUp = false
}

private actor AsyncGate {
	private var isOpen = false
	private var waiters: [CheckedContinuation<Void, Never>] = []
	func wait() async {
		if isOpen { return }
		await withCheckedContinuation { waiters.append($0) }
	}
	func open() {
		isOpen = true
		for w in waiters { w.resume() }
		waiters = []
	}
}

@MainActor
private func makeStore(_ rig: Rig, api: FakeChatAPI, known: Date?) -> ChatStore {
	let outbox = Outbox(
		fileURL: temporaryOutboxFile(), executor: ChatSendExecutor(api: api, onDelivered: { _, _ in }),
		network: ManualNetworkMonitor(), workspaceId: { "ws-1" })
	return ChatStore(
		conversationID: "c1", currentActorID: "me", currentActorName: "Me", api: api,
		queue: ChatSendQueue(outbox: outbox), events: nil, pollInterval: nil, cache: rig.cache,
		knownLastMessageAt: known)
}
