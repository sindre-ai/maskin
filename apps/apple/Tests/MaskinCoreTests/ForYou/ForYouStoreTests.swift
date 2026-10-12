import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

final class FakeForYouSource: ForYouSource, @unchecked Sendable {
	private let lock = NSLock()
	private var _feed: Result<[ForYouCard], ForYouLoadError> = .success([])
	private var _fetches = 0
	var actors: [ForYouActor] = [ForYouActor(id: "agent-1", name: "Forge", isAgent: true)]

	var feed: Result<[ForYouCard], ForYouLoadError> {
		get { lock.withLock { _feed } }
		set { lock.withLock { _feed = newValue } }
	}
	var fetches: Int { lock.withLock { _fetches } }

	func fetchFeed(workspaceId: String) async throws -> [ForYouCard] {
		let result = lock.withLock {
			_fetches += 1
			return _feed
		}
		return try result.get()
	}
	func fetchActors(workspaceId: String) async throws -> [ForYouActor] { actors }
	func fetchBrief(workspaceId: String) async throws -> ForYouBrief {
		ForYouBrief(markdown: "# Brief\nAll quiet.")
	}
}

private func decisionCard(
	_ id: String, title: String = "Ship it?", attention: Int? = nil, event: Int? = 10, age: TimeInterval = 60
) -> ForYouCard {
	ForYouCard(
		id: id, objectTitle: "Object \(id)", objectType: "bet", status: "active",
		maxAttention: attention, latestEventId: event,
		latestActivityAt: Date().addingTimeInterval(-age),
		mention: ForYouMention(
			eventId: 7, actorId: "agent-1", content: "ask",
			decision: DecisionPrompt(
				title: title, summary: "1 thing.", ask: "I cannot.",
				options: [
					DecisionOption(label: "Ship", consequences: ["Ships"], recommended: true),
					DecisionOption(label: "Hold", consequences: ["Waits"]),
				])))
}

private func destructiveCard(_ id: String) -> ForYouCard {
	var card = decisionCard(id)
	card.mention?.decision?.options = [
		DecisionOption(label: "Delete", consequences: ["Gone"], recommended: true, destructive: true),
		DecisionOption(label: "Keep", consequences: ["Stays"]),
	]
	return card
}

private func threadCard(_ id: String, age: TimeInterval = 120) -> ForYouCard {
	ForYouCard(
		id: id, objectTitle: "Thread \(id)", objectType: "task", latestEventId: 20,
		latestActivityAt: Date().addingTimeInterval(-age),
		mention: ForYouMention(eventId: 8, actorId: "agent-1", content: "FYI the build is green."))
}

@MainActor
struct ForYouStoreTests {
	private func make(
		source: FakeForYouSource = FakeForYouSource(), window: TimeInterval = 0.1,
		defaults: UserDefaults? = nil
	) -> (ForYouStore, FakeForYouSource, FakeDecisionBackend, Outbox) {
		let backend = FakeDecisionBackend()
		let outbox = Outbox(
			fileURL: temporaryOutboxFile(), executor: DecisionOutboxExecutor(backend: backend),
			network: ManualNetworkMonitor(), workspaceId: { "ws-1" }, backoff: { _ in 0.02 })
		let decisions = DecisionService(outbox: outbox, undoWindow: window)
		let suite = defaults ?? UserDefaults(suiteName: "foryou-tests-\(UUID().uuidString)")!
		let store = ForYouStore(
			source: source, decisions: decisions, workspaceId: { "ws-1" }, defaults: suite,
			eventDebounce: .milliseconds(10))
		return (store, source, backend, outbox)
	}

	@Test func loadsTheFeedAndResolvesNames() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a"), threadCard("b")])
		#expect(store.phase == .idle)
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.entries.map(\.id) == ["a", "b"])
		#expect(store.entries.map(\.bucket) == [.needs, .fyi])
		#expect(store.senderName(of: store.entries[0].card) == "Forge")
		#expect(store.needsCount == 1)
		#expect(store.unreadCount == 2)
	}

	@Test func emptyFeedIsEmptyNotFailed() async {
		let (store, _, _, _) = make()
		#expect(!store.isEmpty)  // not before it loaded
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.isEmpty)
	}

	@Test func failedFirstLoadShowsErrorAndRetryRecovers() async {
		let (store, source, _, _) = make()
		source.feed = .failure(ForYouLoadError("Couldn't load your feed."))
		await store.load()
		#expect(store.phase == .failed("Couldn't load your feed."))
		#expect(!store.isEmpty)  // a failure never reads as "caught up"
		source.feed = .success([decisionCard("a")])
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.entries.count == 1)
	}

	@Test func aFailedRefreshKeepsWhatIsOnScreen() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		source.feed = .failure(ForYouLoadError("offline"))
		await store.refresh()
		#expect(store.phase == .loaded)
		#expect(store.entries.map(\.id) == ["a"])
		#expect(!store.isRefreshing)
	}

	@Test func ordersByBucketThenAttentionThenRecency() async {
		let (store, source, _, _) = make()
		source.feed = .success([
			threadCard("fyi"),
			decisionCard("low", attention: 2, age: 10),
			decisionCard("high", attention: 5, age: 500),
			decisionCard("none", attention: nil, age: 5),
		])
		await store.load()
		#expect(store.entries.map(\.id) == ["high", "low", "none", "fyi"])
		store.options.sort = .latest
		#expect(store.entries.map(\.id) == ["none", "low", "high", "fyi"])
	}

	@Test func typeFilterAndPersistedOptions() async {
		let defaults = UserDefaults(suiteName: "foryou-tests-\(UUID().uuidString)")!
		let (store, source, _, _) = make(defaults: defaults)
		source.feed = .success([decisionCard("a"), threadCard("b")])
		await store.load()
		#expect(store.typeCounts.map(\.type) == ["bet", "task"])
		store.options = ForYouDisplayOptions(mode: .list, sort: .latest, typeFilter: "task")
		#expect(store.entries.map(\.id) == ["b"])
		let (reopened, _, _, _) = make(defaults: defaults)
		#expect(reopened.options == ForYouDisplayOptions(mode: .list, sort: .latest, typeFilter: "task"))
	}

	@Test func decidedCardStaysAsAReceiptAfterTheServerDropsIt() async {
		let (store, source, backend, _) = make()
		source.feed = .success([decisionCard("a"), threadCard("b")])
		await store.load()
		let card = store.entries[0].card
		store.choose(card.decision!.options[1], on: card)
		#expect(store.entries.first(where: { $0.id == "a" })?.bucket == .done)  // optimistic, instantly
		#expect(await eventually { backend.calls.count == 2 })

		// The server no longer lists it (thread read) but the receipt stays this sitting.
		source.feed = .success([threadCard("b")])
		await store.refresh()
		#expect(store.entries.map(\.id) == ["b", "a"])
		#expect(store.entries.last?.bucket == .done)
	}

	@Test func aCardKeepsItsPlaceWhileTheUndoWindowIsOpen() async {
		let (store, source, _, _) = make(window: 5)
		source.feed = .success([decisionCard("a"), decisionCard("b")])
		await store.load()
		let ids = store.entries.map(\.id)
		let first = store.entries[0].card
		store.choose(first.decision!.options[0], on: first)
		#expect(store.entries.map(\.id) == ids)
		#expect(store.entries[0].bucket == .done)
	}

	@Test func typedReplyMovesTheCardToWaiting() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		store.reply("Go ahead", on: store.entries[0].card)
		#expect(store.entries[0].bucket == .waiting)
	}

	@Test func undoPutsTheCardBackWithItsOptions() async {
		let (store, source, backend, _) = make(window: 0.5)
		source.feed = .success([decisionCard("a")])
		await store.load()
		let card = store.entries[0].card
		store.choose(card.decision!.options[0], on: card)
		#expect(store.entries[0].bucket == .done)
		#expect(store.undo(card))
		#expect(store.entries[0].bucket == .needs)
		try? await Task.sleep(for: .milliseconds(700))
		#expect(backend.calls.isEmpty)
	}

	@Test func aRejectedDecisionRollsTheCardBackToNeedsYou() async {
		let (store, source, backend, _) = make()
		backend.commentError = OutboxRejection(status: 403, message: "Not allowed.")
		source.feed = .success([decisionCard("a")])
		await store.load()
		store.choose(store.entries[0].card.decision!.options[0], on: store.entries[0].card)
		#expect(await eventually {
			if case .failed = store.entries.first?.record?.phase { true } else { false }
		})
		#expect(store.entries[0].bucket == .needs)
	}

	@Test func dismissAllFYIsLeavesDecisionsAlone() async {
		let (store, source, backend, _) = make()
		source.feed = .success([decisionCard("a"), threadCard("b"), threadCard("c")])
		await store.load()
		store.dismissAllFYIs()
		#expect(store.entries.map(\.bucket) == [.needs, .done, .done])
		#expect(await eventually { backend.calls.count == 2 })
		#expect(backend.calls.allSatisfy { $0.hasPrefix("read:") })
	}

	@Test func takeSuggestedUsesTheRecommendedOption() async {
		let (store, source, backend, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		store.takeSuggestedOptions()
		#expect(await eventually { backend.calls.first == "comment:a:Ship:7" })
	}

	@Test func takeSuggestedLeavesIrreversibleOptionsAlone() async {
		let (store, source, backend, _) = make()
		source.feed = .success([destructiveCard("a")])
		await store.load()
		#expect(store.suggestedOptionCount == 0)
		store.takeSuggestedOptions()
		#expect(backend.calls.isEmpty)

		source.feed = .success([destructiveCard("a"), decisionCard("b")])
		await store.refresh()
		#expect(store.suggestedOptionCount == 1)
	}

	@Test func liveEventsRefreshTheFeed() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		let before = source.fetches

		let json =
			#"{"workspace_id":"ws-1","actor_id":"x","action":"commented","entity_type":"object","entity_id":"a","event_id":"1"}"#
		let body = "id: 1\nevent: commented\ndata: \(json)\n\n"
		let client = SSEClient(
			open: { _ in
				AsyncThrowingStream { c in
					for b in body.utf8 { c.yield(b) }
				}
			},
			backoff: SSEBackoff(initial: .milliseconds(1), max: .milliseconds(2)),
			silenceTimeout: .seconds(30))
		let hub = EventHub(client: client)
		store.start(events: hub)
		source.feed = .success([decisionCard("a"), decisionCard("new")])
		hub.connect(workspaceId: "ws-1")
		#expect(await eventually { store.entries.count == 2 })
		#expect(source.fetches > before)
		hub.disconnect()
	}

	@Test func loadsTheBrief() async {
		let (store, _, _, _) = make()
		await store.loadBrief()
		#expect(store.brief == .loaded(ForYouBrief(markdown: "# Brief\nAll quiet.")))
	}
}
