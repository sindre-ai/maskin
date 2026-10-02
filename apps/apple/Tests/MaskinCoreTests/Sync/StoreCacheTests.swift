import Foundation
import Testing

@testable import MaskinCore

/// Who is signed in and which workspace is selected, switchable mid-test.
@MainActor
private final class Identity {
	var actor: String? = "actor-a"
	var workspace: String? = "ws-1"
}

private final class Tick: @unchecked Sendable {
	private let lock = NSLock()
	private var date = Date(timeIntervalSince1970: 3_000_000)
	var now: Date { lock.withLock { date } }
	func advance(_ s: TimeInterval) { lock.withLock { date = date.addingTimeInterval(s) } }
}

@MainActor
private struct Rig {
	let directory: URL
	let disk: DiskCache
	let identity = Identity()
	let tick = Tick()

	init() {
		directory = FileManager.default.temporaryDirectory.appendingPathComponent(
			"storecache-\(UUID().uuidString)")
		let tick = tick
		disk = DiskCache(directory: directory, now: { tick.now })
	}

	var cache: SnapshotCache {
		let identity = identity
		let tick = tick
		return SnapshotCache(
			disk: disk, actorId: { identity.actor }, workspaceId: { identity.workspace },
			now: { tick.now })
	}

	func cleanUp() { try? FileManager.default.removeItem(at: directory) }
}

// MARK: - For You

@MainActor
@Suite("Store cache: For You")
struct ForYouCacheTests {
	private func store(_ rig: Rig, _ source: FakeForYouSource) -> ForYouStore {
		let backend = FakeDecisionBackend()
		let outbox = Outbox(
			fileURL: temporaryOutboxFile(), executor: DecisionOutboxExecutor(backend: backend),
			network: ManualNetworkMonitor(), workspaceId: { rig.identity.workspace })
		let identity = rig.identity
		return ForYouStore(
			source: source, decisions: DecisionService(outbox: outbox),
			workspaceId: { identity.workspace },
			defaults: UserDefaults(suiteName: "fy-cache-\(UUID().uuidString)")!,
			eventDebounce: .milliseconds(10), cache: rig.cache)
	}

	private func card(_ id: String) -> ForYouCard {
		ForYouCard(
			id: id, objectTitle: "Object \(id)", objectType: "task", latestEventId: 5,
			mention: ForYouMention(eventId: 1, actorId: "agent-1", content: "Heads up."))
	}

	@Test func cachedFeedIsShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let source = FakeForYouSource()
		source.feed = .success([card("a")])
		await store(rig, source).load()

		let fresh = FakeForYouSource()
		let second = store(rig, fresh)
		// No await: the first frame already has real data.
		#expect(second.cards.map(\.id) == ["a"])
		#expect(second.phase == .loaded)
		#expect(second.freshness.source == .cache)
		#expect(second.freshness.isStale)
		#expect(fresh.fetches == 0)
	}

	@Test func revalidatingReplacesTheCachedFeed() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let source = FakeForYouSource()
		source.feed = .success([card("a")])
		await store(rig, source).load()

		let next = FakeForYouSource()
		next.feed = .success([card("b")])
		let second = store(rig, next)
		await second.load()
		#expect(second.cards.map(\.id) == ["b"])
		#expect(second.freshness.source == .network)
		#expect(!second.freshness.isStale)
	}

	@Test func aFailedRevalidateKeepsTheCachedFeed() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let source = FakeForYouSource()
		source.feed = .success([card("a")])
		await store(rig, source).load()

		let failing = FakeForYouSource()
		failing.feed = .failure(ForYouLoadError("down"))
		let second = store(rig, failing)
		await second.load()
		#expect(second.cards.map(\.id) == ["a"])
		#expect(second.phase == .loaded)
		#expect(second.freshness.isStale)
		#expect(second.freshness.lastRevalidateFailed)
	}

	@Test func anotherActorSeesNothingOfMyFeed() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let source = FakeForYouSource()
		source.feed = .success([card("a")])
		await store(rig, source).load()

		rig.identity.actor = "actor-b"
		let other = store(rig, FakeForYouSource())
		#expect(other.cards.isEmpty)
		#expect(other.phase == .idle)
	}

	@Test func anotherWorkspaceSeesNothingOfMyFeed() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let source = FakeForYouSource()
		source.feed = .success([card("a")])
		await store(rig, source).load()

		rig.identity.workspace = "ws-2"
		#expect(store(rig, FakeForYouSource()).cards.isEmpty)
	}

	@Test func signingOutWipesTheCache() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let source = FakeForYouSource()
		source.feed = .success([card("a")])
		await store(rig, source).load()
		rig.disk.clearAll()
		#expect(store(rig, FakeForYouSource()).cards.isEmpty)
	}
}

// MARK: - Objects

@MainActor
@Suite("Store cache: Objects")
struct ObjectsCacheTests {
	private func store(_ rig: Rig, _ remote: FakeObjectsRemote) -> ObjectsStore {
		ObjectsStore(
			remote: remote, directory: ObjectsDirectory(remote: remote, actors: Fixtures.actors),
			cache: rig.cache)
	}

	@Test func cachedListIsShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let first = FakeObjectsRemote(objects: Fixtures.objects)
		await store(rig, first).load()

		let idle = FakeObjectsRemote(objects: [])
		let second = store(rig, idle)
		#expect(second.objects.map(\.id) == Fixtures.objects.map(\.id))
		#expect(second.phase == .loaded)
		#expect(second.freshness.source == .cache)
		#expect(idle.listQueries.isEmpty)
	}

	@Test func loadRevalidatesAHydratedListAndReplacesIt() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeObjectsRemote(objects: Fixtures.objects)).load()

		let changed = FakeObjectsRemote(objects: [Fixtures.objects[0]])
		let second = store(rig, changed)
		await second.load()
		#expect(second.objects.map(\.id) == [Fixtures.objects[0].id])
		#expect(second.freshness.source == .network)
		#expect(changed.listQueries.count == 1)
	}

	@Test func aFailedRevalidateKeepsTheCachedList() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeObjectsRemote(objects: Fixtures.objects)).load()

		let down = FakeObjectsRemote(objects: [])
		down.fail("list")
		down.goOffline(true)
		let second = store(rig, down)
		await second.load()
		#expect(second.objects.count == Fixtures.objects.count)
		#expect(second.phase == .loaded)
		#expect(second.isOffline)
		#expect(second.freshness.isStale)
	}

	@Test func anotherActorSeesNothing() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeObjectsRemote(objects: Fixtures.objects)).load()
		rig.identity.actor = "actor-b"
		let other = store(rig, FakeObjectsRemote(objects: []))
		#expect(other.objects.isEmpty)
		#expect(other.phase == .idle)
	}

	@Test func aFilteredListIsNeverCached() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let remote = FakeObjectsRemote(objects: Fixtures.objects)
		let first = store(rig, remote)
		await first.setType("bet")
		let second = store(rig, FakeObjectsRemote(objects: []))
		#expect(second.objects.isEmpty)
	}
}

@MainActor
@Suite("Store cache: Object detail")
struct ObjectDetailCacheTests {
	private func store(_ rig: Rig, _ remote: FakeObjectsRemote, id: String) -> ObjectDetailStore {
		ObjectDetailStore(
			objectId: id, remote: remote,
			directory: ObjectsDirectory(remote: remote, actors: Fixtures.actors),
			currentActorId: "me", cache: rig.cache)
	}

	private func remote(for id: String) -> FakeObjectsRemote {
		let remote = FakeObjectsRemote(objects: Fixtures.objects)
		remote.setGraph(Fixtures.graph(for: Fixtures.objects.first { $0.id == id }!))
		return remote
	}

	@Test func cachedObjectIsShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, remote(for: "t1"), id: "t1").load()

		let second = store(rig, FakeObjectsRemote(), id: "t1")
		#expect(second.object?.id == "t1")
		#expect(second.phase == .loaded)
		#expect(second.freshness.source == .cache)
	}

	@Test func aFailedRevalidateKeepsTheCachedObject() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, remote(for: "t1"), id: "t1").load()

		let down = FakeObjectsRemote()
		down.fail("graph")
		let second = store(rig, down, id: "t1")
		await second.load()
		#expect(second.object?.id == "t1")
		#expect(second.phase == .loaded)
		#expect(second.freshness.isStale)
	}

	@Test func successfulRevalidateReplacesIt() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, remote(for: "t1"), id: "t1").load()
		let next = remote(for: "t1")
		var changed = Fixtures.objects.first { $0.id == "t1" }!
		changed.title = "Renamed on the server"
		next.setGraph(Fixtures.graph(for: changed))
		let second = store(rig, next, id: "t1")
		await second.load()
		#expect(second.object?.title == "Renamed on the server")
		#expect(second.freshness.source == .network)
	}

	@Test func anotherActorSeesNothing() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, remote(for: "t1"), id: "t1").load()
		rig.identity.actor = "actor-b"
		#expect(store(rig, FakeObjectsRemote(), id: "t1").object == nil)
	}

	@Test func anObjectDeletedElsewhereDropsItsCacheEntry() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, remote(for: "t1"), id: "t1").load()
		// The server no longer knows it: no graph registered.
		let gone = store(rig, FakeObjectsRemote(), id: "t1")
		await gone.load()
		#expect(gone.phase == .gone)
		#expect(store(rig, FakeObjectsRemote(), id: "t1").object == nil)
	}
}

// MARK: - Notifications

@MainActor
@Suite("Store cache: Notifications")
struct NotificationsCacheTests {
	private func store(_ rig: Rig, _ source: FakeNotificationsSource) -> NotificationsStore {
		let identity = rig.identity
		return NotificationsStore(
			source: source, currentActorId: { identity.actor }, cache: rig.cache)
	}

	@Test func cachedInboxIsShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeNotificationsSource([makeNotification("n1")])).reload()

		let idle = FakeNotificationsSource([])
		let second = store(rig, idle)
		#expect(second.notifications.map(\.id) == ["n1"])
		#expect(second.unreadCount == 1)
		#expect(second.freshness.source == .cache)
		#expect(await idle.listCalls == 0)
		// The sender's name came with it.
		#expect(second.actor(for: "agent-1")?.name == "Relay")
	}

	@Test func revalidatingReplacesTheCachedInbox() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeNotificationsSource([makeNotification("n1")])).reload()
		let second = store(rig, FakeNotificationsSource([makeNotification("n2")]))
		await second.reload()
		#expect(second.notifications.map(\.id) == ["n2"])
		#expect(second.freshness.source == .network)
	}

	@Test func aFailedRevalidateKeepsTheCachedInbox() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeNotificationsSource([makeNotification("n1")])).reload()
		let down = FakeNotificationsSource([])
		await down.setFailList(true)
		let second = store(rig, down)
		await second.reload()
		#expect(second.notifications.map(\.id) == ["n1"])
		#expect(second.phase == .loaded)
		#expect(second.isOffline)
		#expect(second.freshness.isStale)
	}

	@Test func anotherActorSeesNothing() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeNotificationsSource([makeNotification("n1")])).reload()
		rig.identity.actor = "actor-b"
		#expect(store(rig, FakeNotificationsSource([])).notifications.isEmpty)
	}
}

// MARK: - Loops, Triggers, Agents

@MainActor
@Suite("Store cache: Loops")
struct LoopsCacheTests {
	private func store(_ rig: Rig, _ api: FakeLoopsAPI) -> LoopsStore {
		LoopsStore(api: api, events: nil, cache: rig.cache)
	}

	@Test func cachedLoopsAreShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeLoopsAPI([loopRow("l1", name: "Sales")])).start()
		let idle = FakeLoopsAPI([])
		let second = store(rig, idle)
		#expect(second.loops.map(\.id) == ["l1"])
		#expect(second.freshness.source == .cache)
		#expect(await idle.loopCalls == 0)
		#expect(second.agentNames(for: second.loops[0]) == ["Relay"])
	}

	@Test func revalidatingReplacesAndFailureKeeps() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeLoopsAPI([loopRow("l1")])).start()

		let next = store(rig, FakeLoopsAPI([loopRow("l2")]))
		await next.start()
		#expect(next.loops.map(\.id) == ["l2"])
		#expect(next.freshness.source == .network)

		let down = FakeLoopsAPI([])
		await down.setFailLoops(true)
		let failing = store(rig, down)
		await failing.start()
		#expect(failing.loops.map(\.id) == ["l2"])
		#expect(failing.phase == .loaded)
		#expect(failing.freshness.isStale)
	}

	@Test func anotherActorSeesNothing() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeLoopsAPI([loopRow("l1")])).start()
		rig.identity.actor = "actor-b"
		#expect(store(rig, FakeLoopsAPI([])).loops.isEmpty)
	}
}

@MainActor
@Suite("Store cache: Triggers")
struct TriggersCacheTests {
	private func store(_ rig: Rig, _ api: FakeTriggersAPI) -> TriggersStore {
		TriggersStore(api: api, events: nil, cache: rig.cache)
	}

	@Test func cachedTriggersAreShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeTriggersAPI([trig("t1", name: "Morning", agent: "agent-2")])).start()
		let idle = FakeTriggersAPI([])
		let second = store(rig, idle)
		#expect(second.triggers.map(\.id) == ["t1"])
		#expect(second.freshness.source == .cache)
		#expect(await idle.listCalls == 0)
		#expect(second.agentName(for: second.triggers[0]) == "Forge")
	}

	@Test func revalidatingReplacesAndFailureKeeps() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeTriggersAPI([trig("t1")])).start()

		let next = store(rig, FakeTriggersAPI([trig("t2")]))
		await next.start()
		#expect(next.triggers.map(\.id) == ["t2"])
		#expect(next.freshness.source == .network)

		let down = FakeTriggersAPI([])
		await down.setFailList(true)
		let failing = store(rig, down)
		await failing.start()
		#expect(failing.triggers.map(\.id) == ["t2"])
		#expect(failing.phase == .loaded)
		#expect(failing.freshness.isStale)
	}

	@Test func anotherActorSeesNothing() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeTriggersAPI([trig("t1")])).start()
		rig.identity.actor = "actor-b"
		#expect(store(rig, FakeTriggersAPI([])).triggers.isEmpty)
	}
}

@MainActor
@Suite("Store cache: Agents")
struct AgentsCacheTests {
	private func store(_ rig: Rig, _ api: FakeAgentsAPI) -> AgentsStore {
		AgentsStore(api: api, events: nil, cache: rig.cache)
	}

	@Test func cachedAgentsAreShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeAgentsAPI([agentRow("forge", name: "Forge")])).start()
		let idle = FakeAgentsAPI([])
		let second = store(rig, idle)
		#expect(second.agents.map(\.name) == ["Forge"])
		#expect(second.freshness.source == .cache)
		#expect(await idle.calls == 0)
	}

	@Test func revalidatingReplacesAndFailureKeeps() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeAgentsAPI([agentRow("forge", name: "Forge")])).start()

		let next = store(rig, FakeAgentsAPI([agentRow("relay", name: "Relay")]))
		await next.start()
		#expect(next.agents.map(\.name) == ["Relay"])
		#expect(next.freshness.source == .network)

		let down = FakeAgentsAPI([])
		await down.setFailing(true)
		let failing = store(rig, down)
		await failing.start()
		#expect(failing.agents.map(\.name) == ["Relay"])
		#expect(failing.phase == .loaded)
		#expect(failing.freshness.isStale)
	}

	@Test func anotherActorSeesNothing() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await store(rig, FakeAgentsAPI([agentRow("forge")])).start()
		rig.identity.actor = "actor-b"
		#expect(store(rig, FakeAgentsAPI([])).agents.isEmpty)
	}
}

// MARK: - Workspaces

private struct Authn: Authenticating {
	func login(email: String, password: String) async throws -> LoginResult {
		LoginResult(apiKey: "ank_x", actorId: "a", name: "A", email: nil, workspaceId: nil)
	}
}

@MainActor
private func session(actor: String, workspace: String?) -> AuthSession {
	let secrets = InMemorySecretStore(
		try! JSONEncoder().encode(
			StoredSession(
				apiKey: "ank_x", actorId: actor, name: "A", email: nil, workspaceId: workspace)))
	let auth = AuthSession(authenticator: Authn(), store: secrets)
	auth.restore()
	return auth
}

@MainActor
@Suite("Store cache: Workspaces")
struct WorkspacesCacheTests {
	private let one = WorkspaceSummary(id: "w1", name: "One", role: "owner", memberCount: 1)
	private let two = WorkspaceSummary(id: "w2", name: "Two", role: "member", memberCount: 3)

	@Test func cachedWorkspacesAreShownBeforeAnyNetworkCall() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let auth = session(actor: "a", workspace: "w1")
		await WorkspaceStore(source: StaticWorkspaceSource([one, two]), auth: auth, disk: rig.disk)
			.refresh()

		let second = WorkspaceStore(
			source: StaticWorkspaceSource([]), auth: auth, disk: rig.disk)
		#expect(second.workspaces == [one, two])
		#expect(second.selected == one)
		#expect(second.freshness.source == .cache)
	}

	@Test func aFailedRefreshKeepsTheCachedList() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let auth = session(actor: "a", workspace: "w1")
		await WorkspaceStore(source: StaticWorkspaceSource([one, two]), auth: auth, disk: rig.disk)
			.refresh()
		let second = WorkspaceStore(
			source: StaticWorkspaceSource(failure: WorkspaceListingError("down")), auth: auth,
			disk: rig.disk)
		await second.refresh()
		#expect(second.workspaces == [one, two])
		#expect(second.phase == .loaded)
		#expect(second.freshness.isStale)
	}

	@Test func aSuccessfulRefreshReplacesIt() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		let auth = session(actor: "a", workspace: "w1")
		await WorkspaceStore(source: StaticWorkspaceSource([one, two]), auth: auth, disk: rig.disk)
			.refresh()
		let second = WorkspaceStore(source: StaticWorkspaceSource([two]), auth: auth, disk: rig.disk)
		await second.refresh()
		#expect(second.workspaces == [two])
		#expect(second.freshness.source == .network)
	}

	@Test func anotherActorSeesNothing() async {
		let rig = Rig()
		defer { rig.cleanUp() }
		await WorkspaceStore(
			source: StaticWorkspaceSource([one, two]), auth: session(actor: "a", workspace: "w1"),
			disk: rig.disk
		).refresh()
		let other = WorkspaceStore(
			source: StaticWorkspaceSource([]), auth: session(actor: "b", workspace: nil),
			disk: rig.disk)
		#expect(other.workspaces.isEmpty)
		#expect(other.phase == .idle)
	}
}
