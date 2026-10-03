import Foundation
import Testing

@testable import MaskinCore

// MARK: - Fakes

private struct FakeSource: WidgetDataSource {
	var cards: Result<[ForYouCard], any Error> = .success([])
	var actorList: Result<[ForYouActor], any Error> = .success([])
	var unread: Result<Int, any Error> = .success(0)
	var delay: TimeInterval = 0
	var onUnauthorized: (@Sendable () -> Void)?

	func feed(workspaceId: String) async throws -> [ForYouCard] {
		if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
		do { return try cards.get() } catch {
			// Only a 401 raises the flag; any other failure (offline, 5xx) must fall back to the cache.
			if error is Unauthorized { onUnauthorized?() }
			throw error
		}
	}
	func actors(workspaceId: String) async throws -> [ForYouActor] { try actorList.get() }
	func unreadNotificationCount(workspaceId: String) async throws -> Int { try unread.get() }
}

private struct Boom: Error {}
private struct Unauthorized: Error {}

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func decisionCard(
	_ id: String, title: String = "Ship the pricing page?", attention: Int? = nil,
	actor: String? = "agent-1", activity: Date? = nil, unread: Int = 1, type: String = "bet",
	options: [DecisionOption] = [
		DecisionOption(label: "Hold"), DecisionOption(label: "Ship it", recommended: true),
	]
) -> ForYouCard {
	ForYouCard(
		id: id, objectTitle: "Pricing", objectType: type, unreadCount: unread, maxAttention: attention,
		latestActivityAt: activity,
		mention: ForYouMention(
			eventId: 1, actorId: actor, content: "x",
			decision: DecisionPrompt(title: title, summary: "s", ask: "a", options: options)))
}

private func plainCard(_ id: String) -> ForYouCard {
	ForYouCard(id: id, objectTitle: "Note", objectType: "insight", unreadCount: 2,
		mention: ForYouMention(eventId: 2, content: "FYI only."))
}

private func sessionData(
	actor: String = "actor-1", workspace: String? = "ws-1", key: String = "ank_secret"
) -> Data {
	try! JSONEncoder().encode(
		StoredSession(apiKey: key, actorId: actor, name: "Sam", workspaceId: workspace))
}

private func snapshot(
	needs: Int = 2, unread: Int = 3, at: Date = t0, actor: String = "actor-1", ws: String = "ws-1"
) -> WidgetSnapshot {
	WidgetSnapshot(
		actorId: actor, workspaceId: ws, needsCount: needs,
		decisions: [WidgetSnapshot.Decision(objectId: "obj-1", title: "Ship it?", agentName: "Forge")],
		unreadCount: unread, updatedAt: at)
}

// MARK: - Builder

@Suite("WidgetSnapshotBuilder")
struct WidgetSnapshotBuilderTests {
	private func build(_ cards: [ForYouCard], actors: [ForYouActor] = [], unread: Int = 0) -> WidgetSnapshot {
		WidgetSnapshotBuilder.make(
			cards: cards, actors: actors, unreadNotifications: unread, actorId: "actor-1",
			workspaceId: "ws-1", now: t0)
	}

	@Test("counts only decisions, like the For You needs bucket")
	func countsDecisionsOnly() {
		let s = build([decisionCard("a"), plainCard("b"), decisionCard("c")])
		#expect(s.needsCount == 2)
		#expect(s.decisions.map(\.objectId) == ["a", "c"])
	}

	@Test("skips read cards and onboarding sessions")
	func skipsReadAndOnboarding() {
		let s = build([
			decisionCard("read", unread: 0), decisionCard("onb", type: "onboarding_session"),
			decisionCard("keep"),
		])
		#expect(s.needsCount == 1)
		#expect(s.top?.objectId == "keep")
	}

	@Test("orders by attention, then latest activity")
	func ordering() {
		let s = build([
			decisionCard("low", attention: 1, activity: t0),
			decisionCard("high-old", attention: 9, activity: t0.addingTimeInterval(-100)),
			decisionCard("high-new", attention: 9, activity: t0),
			decisionCard("none", attention: nil, activity: t0.addingTimeInterval(500)),
		])
		#expect(s.decisions.map(\.objectId) == ["high-new", "high-old", "low"])
		#expect(s.needsCount == 4)
	}

	@Test("caps the rows but not the count")
	func capsRows() {
		let s = build((0..<7).map { decisionCard("c\($0)") })
		#expect(s.decisions.count == WidgetSnapshot.maxDecisions)
		#expect(s.needsCount == 7)
	}

	@Test("resolves the sender to a name and never to an id")
	func senderNames() {
		let named = build(
			[decisionCard("a", actor: "agent-1")], actors: [ForYouActor(id: "agent-1", name: "Forge", isAgent: true)])
		#expect(named.top?.agentName == "Forge")
		let unresolved = build([decisionCard("a", actor: "agent-9")])
		#expect(unresolved.top?.agentName == nil)
	}

	@Test("puts the recommended option first and carries the decision title")
	func options() {
		let s = build([decisionCard("a", title: "  Ship it?  ")])
		#expect(s.top?.title == "Ship it?")
		#expect(s.top?.optionLabels == ["Ship it", "Hold"])
		#expect(s.top?.recommendedLabel == "Ship it")
	}

	@Test("clips long titles")
	func clips() {
		let long = String(repeating: "word ", count: 100)
		let s = build([decisionCard("a", title: long)])
		#expect(s.top!.title.count <= WidgetSnapshot.maxTitleLength)
		#expect(s.top!.title.hasSuffix("…"))
	}

	@Test("deep links use the app's own object link shape")
	func deepLinks() {
		let s = build([decisionCard("obj-1")])
		let url = s.url(for: s.top!)
		#expect(url.absoluteString == "maskin://ws-1/objects/obj-1")
		#expect(DeepLink(url: url) == .object(workspaceId: "ws-1", id: "obj-1"))
		let empty = build([])
		#expect(DeepLink(url: empty.tapURL) == .notifications(workspaceId: "ws-1"))
	}

	@Test("unread label caps like the one page the loader reads")
	func unreadLabel() {
		#expect(build([], unread: 7).unreadLabel == "7")
		#expect(build([], unread: WidgetSnapshot.unreadCap).unreadLabel == "99+")
	}
}

// MARK: - Policy

@Suite("WidgetPolicy")
struct WidgetPolicyTests {
	@Test("a snapshot goes stale after 30 minutes and expires after 12 hours")
	func freshness() {
		let s = snapshot()
		#expect(!WidgetPolicy.isStale(s, at: t0.addingTimeInterval(29 * 60)))
		#expect(WidgetPolicy.isStale(s, at: t0.addingTimeInterval(30 * 60)))
		#expect(!WidgetPolicy.isExpired(s, at: t0.addingTimeInterval(11 * 3600)))
		#expect(WidgetPolicy.isExpired(s, at: t0.addingTimeInterval(12 * 3600)))
		// A clock that went backwards never produces a negative age.
		#expect(WidgetPolicy.age(of: s, at: t0.addingTimeInterval(-50)) == 0)
	}

	@Test("an expired snapshot resolves to unavailable, other states are untouched")
	func resolved() {
		let s = snapshot()
		#expect(WidgetState.content(s).resolved(at: t0.addingTimeInterval(60)) == .content(s))
		#expect(WidgetState.content(s).resolved(at: t0.addingTimeInterval(13 * 3600)) == .unavailable)
		#expect(WidgetState.signedOut.resolved(at: t0) == .signedOut)
	}

	@Test("relevance ranks decisions above unread above nothing")
	func relevance() {
		let none = WidgetPolicy.relevance(of: .content(snapshot(needs: 0, unread: 0)))
		let unread = WidgetPolicy.relevance(of: .content(snapshot(needs: 0, unread: 4)))
		let one = WidgetPolicy.relevance(of: .content(snapshot(needs: 1)))
		let many = WidgetPolicy.relevance(of: .content(snapshot(needs: 40)))
		#expect(none == 0)
		#expect(unread > none && one > unread && many > one)
		#expect(many <= 1)
		#expect(WidgetPolicy.relevance(of: .signedOut) == 0)
	}

	@Test("a fresh load reloads in 30 minutes and still schedules stale and expiry entries")
	func freshPlan() {
		let plan = WidgetPolicy.plan(for: .content(snapshot(at: t0)), now: t0.addingTimeInterval(3))
		#expect(plan.reloadAfter == t0.addingTimeInterval(3 + 30 * 60))
		#expect(
			plan.entries == [
				t0.addingTimeInterval(3), t0.addingTimeInterval(30 * 60),
				t0.addingTimeInterval(12 * 3600),
			])
	}

	@Test("a cached fallback retries sooner and schedules its own stale and expiry entries")
	func fallbackPlan() {
		let now = t0.addingTimeInterval(10 * 60)
		let plan = WidgetPolicy.plan(for: .content(snapshot(at: t0)), now: now)
		#expect(plan.reloadAfter == now.addingTimeInterval(5 * 60))
		#expect(plan.entries == [now, t0.addingTimeInterval(30 * 60), t0.addingTimeInterval(12 * 3600)])
	}

	@Test("an already-stale fallback adds only the expiry entry")
	func staleFallbackPlan() {
		let now = t0.addingTimeInterval(2 * 3600)
		let plan = WidgetPolicy.plan(for: .content(snapshot(at: t0)), now: now)
		#expect(plan.entries == [now, t0.addingTimeInterval(12 * 3600)])
	}

	@Test("signed out and unavailable have their own cadence")
	func otherPlans() {
		#expect(WidgetPolicy.plan(for: .signedOut, now: t0).reloadAfter == t0.addingTimeInterval(3600))
		#expect(WidgetPolicy.plan(for: .unavailable, now: t0).reloadAfter == t0.addingTimeInterval(300))
	}
}

// MARK: - Cache

@Suite("FileWidgetSnapshotCache")
struct WidgetCacheTests {
	private func tempURL() -> URL {
		FileManager.default.temporaryDirectory
			.appendingPathComponent("widget-\(UUID().uuidString)/widget-snapshot.json")
	}

	@Test("round-trips a snapshot through the file")
	func roundTrip() {
		let cache = FileWidgetSnapshotCache(fileURL: tempURL())
		#expect(cache.load() == nil)
		let s = snapshot()
		cache.save(s)
		#expect(cache.load() == s)
		cache.clear()
		#expect(cache.load() == nil)
	}

	@Test("a corrupt file is a miss, not a crash")
	func corrupt() throws {
		let url = tempURL()
		try FileManager.default.createDirectory(
			at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		try Data("not json".utf8).write(to: url)
		#expect(FileWidgetSnapshotCache(fileURL: url).load() == nil)
	}

	@Test("the file stays tiny")
	func small() throws {
		let url = tempURL()
		let cache = FileWidgetSnapshotCache(fileURL: url)
		cache.save(snapshot())
		let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as! Int
		#expect(size < 2_000)
	}
}

// MARK: - Loader

@Suite("WidgetSnapshotLoader")
struct WidgetSnapshotLoaderTests {
	private func loader(
		secret: Data?, cache: InMemoryWidgetSnapshotCache = InMemoryWidgetSnapshotCache(),
		source: FakeSource, timeout: TimeInterval = 5
	) -> WidgetSnapshotLoader {
		WidgetSnapshotLoader(
			secrets: InMemorySecretStore(secret), cache: cache, timeout: timeout, now: { t0 },
			makeSource: { _, flag in
				var s = source
				s.onUnauthorized = { flag.raise() }
				return s
			})
	}

	@Test("signed out: no session means the signed-out state and an empty cache")
	func signedOut() async {
		let cache = InMemoryWidgetSnapshotCache(snapshot())
		let state = await loader(secret: nil, cache: cache, source: FakeSource()).load()
		#expect(state == .signedOut)
		#expect(cache.load() == nil)
	}

	@Test("a session without a workspace is treated as signed out")
	func noWorkspace() async {
		let state = await loader(secret: sessionData(workspace: nil), source: FakeSource()).load()
		#expect(state == .signedOut)
	}

	@Test("builds a snapshot from the feed, names and notifications, and caches it")
	func happyPath() async {
		let cache = InMemoryWidgetSnapshotCache()
		let source = FakeSource(
			cards: .success([decisionCard("a"), plainCard("b")]),
			actorList: .success([ForYouActor(id: "agent-1", name: "Forge", isAgent: true)]),
			unread: .success(4))
		let state = await loader(secret: sessionData(), cache: cache, source: source).load()
		guard case .content(let s) = state else { Issue.record("expected content"); return }
		#expect(s.needsCount == 1 && s.unreadCount == 4)
		#expect(s.top?.agentName == "Forge")
		#expect(s.actorId == "actor-1" && s.workspaceId == "ws-1" && s.updatedAt == t0)
		#expect(cache.load() == s)
	}

	@Test("failed names or notification count don't blank the widget")
	func garnishFailures() async {
		let cache = InMemoryWidgetSnapshotCache(snapshot(unread: 9, at: t0.addingTimeInterval(-3600)))
		let source = FakeSource(
			cards: .success([decisionCard("a")]), actorList: .failure(Boom()), unread: .failure(Boom()))
		let state = await loader(secret: sessionData(), cache: cache, source: source).load()
		guard case .content(let s) = state else { Issue.record("expected content"); return }
		#expect(s.needsCount == 1)
		#expect(s.top?.agentName == nil)
		#expect(s.unreadCount == 9)
	}

	@Test("offline: falls back to the cached snapshot")
	func offlineFallback() async {
		let cached = snapshot(at: t0.addingTimeInterval(-600))
		let state = await loader(
			secret: sessionData(), cache: InMemoryWidgetSnapshotCache(cached),
			source: FakeSource(cards: .failure(Boom()))
		).load()
		#expect(state == .content(cached))
	}

	@Test("offline with nothing cached is unavailable")
	func offlineNoCache() async {
		let state = await loader(secret: sessionData(), source: FakeSource(cards: .failure(Boom()))).load()
		#expect(state == .unavailable)
	}

	@Test("never falls back to another actor's or workspace's snapshot")
	func ignoresForeignCache() async {
		for foreign in [snapshot(actor: "someone-else"), snapshot(ws: "ws-other")] {
			let state = await loader(
				secret: sessionData(), cache: InMemoryWidgetSnapshotCache(foreign),
				source: FakeSource(cards: .failure(Boom()))
			).load()
			#expect(state == .unavailable)
		}
	}

	@Test("a 401 shows signed out and drops the cache")
	func unauthorized() async {
		let cache = InMemoryWidgetSnapshotCache(snapshot())
		let state = await loader(
			secret: sessionData(), cache: cache, source: FakeSource(cards: .failure(Unauthorized()))
		).load()
		// The fake raises the flag on a feed failure, standing in for the middleware's 401 hook.
		#expect(state == .signedOut)
		#expect(cache.load() == nil)
	}

	@Test("a slow server times out and falls back to the cache")
	func timeout() async {
		let cached = snapshot(at: t0.addingTimeInterval(-60))
		let started = Date()
		let state = await loader(
			secret: sessionData(), cache: InMemoryWidgetSnapshotCache(cached),
			source: FakeSource(cards: .success([decisionCard("a")]), delay: 3), timeout: 0.2
		).load()
		#expect(state == .content(cached))
		#expect(Date().timeIntervalSince(started) < 2)
	}
}

// MARK: - Reloader

@Suite("DebouncedWidgetReloader")
struct DebouncedWidgetReloaderTests {
	private final class Counter: WidgetReloader, @unchecked Sendable {
		private let lock = NSLock()
		private var n = 0
		var count: Int { lock.withLock { n } }
		func reload() { lock.withLock { n += 1 } }
	}

	@Test("a burst of calls produces a single reload")
	func coalesces() async throws {
		let counter = Counter()
		let reloader = DebouncedWidgetReloader(wrapping: counter, delay: 0.05)
		for _ in 0..<5 { reloader.reload() }
		#expect(counter.count == 0)
		try await Task.sleep(nanoseconds: 300_000_000)
		#expect(counter.count == 1)
		reloader.reload()
		try await Task.sleep(nanoseconds: 300_000_000)
		#expect(counter.count == 2)
	}
}
