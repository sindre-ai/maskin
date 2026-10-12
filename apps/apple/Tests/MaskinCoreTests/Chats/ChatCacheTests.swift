import Foundation
import Testing

@testable import MaskinCore

@MainActor
private final class Identity {
	var actor: String? = "actor-a"
	var workspace: String? = "ws-1"
}

@MainActor
private struct Rig {
	let directory = FileManager.default.temporaryDirectory.appendingPathComponent("chatcache-\(UUID().uuidString)")
	let disk: DiskCache
	let identity = Identity()

	init() { disk = DiskCache(directory: directory) }

	var cache: SnapshotCache {
		let identity = identity
		return SnapshotCache(disk: disk, actorId: { identity.actor }, workspaceId: { identity.workspace })
	}

	func cleanUp() { try? FileManager.default.removeItem(at: directory) }
}

@MainActor
private func thread(_ rig: Rig, _ api: FakeChatAPI) -> ChatStore {
	let outbox = Outbox(
		fileURL: temporaryOutboxFile(), executor: ChatSendExecutor(api: api, onDelivered: { _, _ in }),
		network: ManualNetworkMonitor(), workspaceId: { "ws-1" })
	return ChatStore(
		conversationID: "c1", currentActorID: "me", currentActorName: "Me", api: api,
		queue: ChatSendQueue(outbox: outbox), events: nil, pollInterval: nil, cache: rig.cache)
}

@Suite("Chat cache: thread")
@MainActor
struct ChatThreadCacheTests {
	@Test("handoff rows survive the cache, and a cache written before them still decodes")
	func handoffsRoundTrip() throws {
		let spawned = SpawnedSession(
			id: "s1", status: "running", actorID: "dev", actorName: "Dev", actionPrompt: "Fix it",
			currentActivity: "Reading")
		var message = chatMsg(1, by: "relay", agent: true, "handing off")
		message.spawnedSessions = [spawned]
		let cached = try #require(ChatCaching.CachedMessage(message))
		let decoded = try JSONDecoder().decode(
			ChatCaching.CachedMessage.self, from: JSONEncoder().encode(cached))
		#expect(decoded.message.spawnedSessions == [spawned])

		// An entry from before the field existed has no such key at all.
		var object = try #require(
			JSONSerialization.jsonObject(with: JSONEncoder().encode(cached)) as? [String: Any])
		object["spawnedSessions"] = nil
		let old = try JSONDecoder().decode(
			ChatCaching.CachedMessage.self, from: JSONSerialization.data(withJSONObject: object))
		#expect(old.message.spawnedSessions.isEmpty)
	}

	@Test("a cached thread is on screen before any network call, then revalidated")
	func hydratesThenRevalidates() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let first = thread(rig, FakeChatAPI(server: [chatMsg(1, "hello"), chatMsg(2, by: "relay", agent: true, "hi")]))
		await first.load()

		let api = FakeChatAPI(server: [chatMsg(1, "hello"), chatMsg(2, by: "relay", agent: true, "hi"), chatMsg(3, "new")])
		let second = thread(rig, api)
		#expect(second.messages.compactMap(\.serverID) == [1, 2], "cached before any await")
		#expect(second.phase == .loaded)
		#expect(second.freshness.source == .cache)
		#expect(await api.messageCalls.isEmpty)
		await second.load()
		#expect(second.messages.compactMap(\.serverID) == [1, 2, 3])
		#expect(second.freshness.source == .network)
	}

	@Test("a failed revalidate keeps the cached thread and raises no alert")
	func failedRevalidateKeepsThread() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await thread(rig, FakeChatAPI(server: [chatMsg(1, "keep me")])).load()
		let api = FakeChatAPI(server: [])
		await api.setFailMessages(true)
		let store = thread(rig, api)
		await store.load()
		#expect(store.messages.map(\.content) == ["keep me"])
		#expect(store.phase == .loaded)
		#expect(store.freshness.lastRevalidateFailed)
		#expect(store.notice == nil)
	}

	@Test("another actor, or another workspace, sees nothing")
	func isolation() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await thread(rig, FakeChatAPI(server: [chatMsg(1, "secret")])).load()
		rig.identity.actor = "actor-b"
		#expect(thread(rig, FakeChatAPI()).messages.isEmpty)
		rig.identity.actor = "actor-a"
		rig.identity.workspace = "ws-2"
		#expect(thread(rig, FakeChatAPI()).messages.isEmpty)
		rig.identity.workspace = "ws-1"
		#expect(thread(rig, FakeChatAPI()).messages.count == 1)
		rig.disk.clear(actorId: "actor-a")
		#expect(thread(rig, FakeChatAPI()).messages.isEmpty)
	}

	@Test("an entry from another cache version is discarded")
	func versionBump() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await thread(rig, FakeChatAPI(server: [chatMsg(1, "old shape")])).load()
		// A reader on a newer version (a changed snapshot shape) must see a miss, and not crash.
		let miss = rig.cache.read(ChatCaching.ThreadSnapshot.self, ChatCaching.threadName("c1"), version: ChatCaching.version + 1)
		#expect(miss == nil)
		// A value that no longer decodes is a miss too.
		struct Other: Codable, Sendable { var unrelated: Int }
		rig.cache.write(Other(unrelated: 1), ChatCaching.threadName("c1"), version: ChatCaching.version)
		#expect(thread(rig, FakeChatAPI()).messages.isEmpty)
	}

	@Test("only the newest page is stored, without sent-but-unconfirmed rows or stream metadata")
	func boundedAndMinimal() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let noisy = chatMsg(
			60, by: "relay", agent: true, "done",
			metadata: .object(["final_output": .object(["dedupe_key": .string("abc"), "is_error": .bool(true)]), "source": .string("final_output")]))
		let rows = (1...59).map { chatMsg($0) } + [noisy]
		let store = thread(rig, FakeChatAPI(server: rows))
		await store.load()
		let snapshot = rig.cache.read(ChatCaching.ThreadSnapshot.self, ChatCaching.threadName("c1"), version: ChatCaching.version)?.value
		#expect(snapshot?.messages.count == ChatCaching.threadMessageLimit)
		let cachedNoisy = snapshot?.messages.last
		#expect(cachedNoisy?.metadata == nil, "stream envelope keys are dropped")
		#expect(cachedNoisy?.isError == true)
		let again = thread(rig, FakeChatAPI())
		#expect(again.messages.last?.isErrorReply == true)
		#expect(again.hasEarlier)
	}
}

@Suite("Chat cache: list")
@MainActor
struct ChatListCacheTests {
	@Test("cached conversations show before any await, a failed revalidate keeps them, others see nothing")
	func list() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await ConversationsStore(api: FakeListAPI([chatConvo("a", unread: 2), chatConvo("b")]), events: nil, cache: rig.cache).refresh()

		let api = FakeListAPI([])
		await api.setFailList(true)
		let store = ConversationsStore(api: api, events: nil, cache: rig.cache)
		#expect(store.conversations.map(\.id) == ["a", "b"])
		#expect(store.phase == .loaded)
		#expect(store.totalUnread == 2)
		await store.refresh()
		#expect(store.conversations.map(\.id) == ["a", "b"], "failed revalidate keeps the list")
		#expect(store.freshness.lastRevalidateFailed)

		rig.identity.actor = "actor-b"
		#expect(ConversationsStore(api: FakeListAPI([]), events: nil, cache: rig.cache).conversations.isEmpty)
	}

	@Test("a filtered or archived list is never written over the cache")
	func filteredNotCached() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let store = ConversationsStore(api: FakeListAPI([chatConvo("a")]), events: nil, cache: rig.cache)
		await store.refresh()
		store.filter = .unread
		_ = await eventually { store.phase == .loaded }
		let cached = rig.cache.read(ChatCaching.ListSnapshot.self, ChatCaching.listName, version: ChatCaching.version)
		#expect(cached?.value.conversations.map(\.id) == ["a"])
	}
}
