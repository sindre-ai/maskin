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

final class TestClock: @unchecked Sendable {
	private let lock = NSLock()
	private var _now: Date
	init(_ now: Date) { _now = now }
	var now: Date {
		get { lock.withLock { _now } }
		set { lock.withLock { _now = newValue } }
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
		defaults: UserDefaults? = nil, now: @escaping @Sendable () -> Date = { Date() }
	) -> (ForYouStore, FakeForYouSource, FakeDecisionBackend, Outbox) {
		let backend = FakeDecisionBackend()
		let outbox = Outbox(
			fileURL: temporaryOutboxFile(), executor: DecisionOutboxExecutor(backend: backend),
			network: ManualNetworkMonitor(), workspaceId: { "ws-1" }, backoff: { _ in 0.02 })
		let decisions = DecisionService(outbox: outbox, undoWindow: window)
		let suite = defaults ?? UserDefaults(suiteName: "foryou-tests-\(UUID().uuidString)")!
		let store = ForYouStore(
			source: source, decisions: decisions, workspaceId: { "ws-1" }, defaults: suite,
			eventDebounce: .milliseconds(10), now: now)
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

	@Test func keepsTheChiefOfStaffsRankingOverAttentionAndTheSortSetting() async {
		let (store, source, _, _) = make()
		var first = decisionCard("first", attention: 1, age: 900)
		first.rank = 0
		var second = decisionCard("second", attention: 5, age: 5)
		second.rank = 1
		var third = decisionCard("third", attention: 3, age: 100)
		third.rank = 2
		source.feed = .success([third, second, first])
		await store.load()
		#expect(store.entries.map(\.id) == ["first", "second", "third"])
		store.options.sort = .latest
		#expect(store.entries.map(\.id) == ["first", "second", "third"])
	}

	@Test func intentFilterAndPersistedOptions() async {
		let defaults = UserDefaults(suiteName: "foryou-tests-\(UUID().uuidString)")!
		let (store, source, _, _) = make(defaults: defaults)
		source.feed = .success([decisionCard("a"), threadCard("b")])
		await store.load()
		#expect(store.intentCount(nil) == 2)
		#expect(store.intentCount(.approvals) == 1)
		#expect(store.intentCount(.questions) == 1)
		store.options = ForYouDisplayOptions(
			mode: .list, sort: .latest, intent: .questions, filterBarOn: true, showsHandled: false)
		#expect(store.entries.map(\.id) == ["b"])
		let (reopened, _, _, _) = make(defaults: defaults)
		#expect(
			reopened.options
				== ForYouDisplayOptions(
					mode: .list, sort: .latest, intent: .questions, filterBarOn: true, showsHandled: false))
	}

	@Test func optionsSavedBeforeIntentsStillDecode() throws {
		let old = #"{"mode":"list","sort":"latest","typeFilter":"task"}"#
		let options = try JSONDecoder().decode(ForYouDisplayOptions.self, from: Data(old.utf8))
		#expect(options == ForYouDisplayOptions(mode: .list, sort: .latest))
		#expect(options.showsHandled)
	}

	@Test func actingOnOneMessageOfAStackSendsItsReplyAndLeavesTheCardOpen() async {
		let (store, source, backend, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		let card = store.entries[0].card
		let draft = DecisionDraft(id: "kenneth", label: "DM", to: "Kenneth", body: "Hej.")

		#expect(store.actOnDraft(draft, action: .send, on: card))

		#expect(await eventually { backend.calls.count == 1 })
		#expect(backend.calls == ["comment:a:Send: DM to Kenneth (kenneth):7"])
		#expect(store.entries.first(where: { $0.id == "a" })?.bucket == .needs)  // still open
		#expect(store.entries.first(where: { $0.id == "a" })?.record == nil)
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

	@Test func aDecidedCardLeavesTheOpenListAtOnceAndTheNextOneMovesUp() async {
		let (store, source, _, _) = make(window: 5)
		source.feed = .success([decisionCard("a", attention: 5), decisionCard("b", attention: 1)])
		await store.load()
		let first = store.entries[0].card
		store.choose(first.decision!.options[0], on: first)
		// Held inside the Undo window, but already out of the open list and into Handled.
		#expect(store.entries.map(\.id) == ["b", "a"])
		#expect(store.entries.map(\.bucket) == [.needs, .done])
	}

	@Test func theCountAndBadgeExcludeDecidedHeldAndDeferredCards() async {
		let (store, source, _, _) = make(window: 5)
		source.feed = .success([decisionCard("a"), decisionCard("b"), decisionCard("c"), threadCard("d")])
		await store.load()
		#expect(store.needsCount == 3)
		#expect(store.unreadCount == 4)
		store.choose(store.entries[0].card.decision!.options[0], on: store.entries[0].card)
		store.deferCard(store.entries.first(where: { $0.bucket == .needs })!.card, to: .tomorrowMorning)
		#expect(store.needsCount == 1)
		#expect(store.unreadCount == 2)
		for entry in store.entries where entry.bucket == .needs {
			store.choose(entry.card.decision!.options[0], on: entry.card)
		}
		store.dismiss(store.entries.first(where: { $0.bucket == .fyi })!.card)
		#expect(store.needsCount == 0)
		#expect(store.unreadCount == 0)
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
		#expect(await eventually { store.pendingNewCount == 1 })
		#expect(source.fetches > before)
		// The new ask waits behind the "N new" pill; it does not land above the reader.
		#expect(store.entries.map(\.id) == ["a"])
		store.showNew()
		#expect(store.entries.map(\.id).sorted() == ["a", "new"])
		#expect(store.pendingNewCount == 0)
		hub.disconnect()
	}

	@Test func pullToRefreshShowsNewAsksStraightAway() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		source.feed = .success([decisionCard("a"), decisionCard("b")])
		await store.refresh()
		#expect(store.pendingNewCount == 0)
		#expect(store.entries.count == 2)
	}

	@Test func aLiveRefreshOfAnEmptyListShowsTheNewAskAtOnce() async {
		let (store, source, _, _) = make()
		await store.load()
		source.feed = .success([decisionCard("a")])
		await store.refresh(revealingNew: false)
		// Nothing was on screen to push down, so there is nothing to wait behind.
		#expect(store.pendingNewCount == 0)
		#expect(store.entries.map(\.id) == ["a"])
	}

	@Test func theFirstLoadIsNeverHeldBehindThePill() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a"), threadCard("b")])
		await store.load()
		#expect(store.pendingNewCount == 0)
		#expect(store.entries.count == 2)
	}

	@Test func laterHidesACardAndUndoBringsItBack() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a"), decisionCard("b")])
		await store.load()
		let card = store.entries[0].card
		let other = store.entries[1].id
		let previous = store.deferCard(card, to: .tomorrowMorning)
		#expect(store.entries.map(\.id) == [other])
		#expect(store.laterEntries.map(\.id) == [card.id])
		#expect(store.needsCount == 1)
		store.undoLater(card, restoring: previous)
		#expect(store.entries.count == 2)
		#expect(store.laterEntries.isEmpty)
	}

	@Test func bringBackReturnsADeferredCard() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		store.deferCard(store.entries[0].card, to: .thisEvening)
		#expect(store.entries.isEmpty)
		store.bringBack(store.laterEntries[0].card)
		#expect(store.entries.map(\.id) == ["a"])
	}

	@Test func aDeferredCardComesBackWithANoteWhenItIsDue() async {
		let clock = TestClock(Date())
		let (store, source, _, _) = make(now: { clock.now })
		source.feed = .success([decisionCard("a")])
		await store.load()
		store.deferCard(store.entries[0].card, to: .tomorrowMorning)
		#expect(store.entries.isEmpty)
		clock.now = clock.now.addingTimeInterval(3 * 86_400)
		#expect(store.entries.map(\.id) == ["a"])
		#expect(store.entries[0].backFromLater)
		// Acting on it clears the note.
		store.choose(store.entries[0].card.decision!.options[0], on: store.entries[0].card)
		#expect(store.later.isBackFromLater("a") == false)
	}

	@Test func decidingADeferredCardForgetsTheDeferral() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		store.deferCard(store.entries[0].card, to: .thisEvening)
		store.bringBack(store.laterEntries[0].card)
		store.choose(store.entries[0].card.decision!.options[0], on: store.entries[0].card)
		#expect(store.later.entry(for: "a") == nil)
	}

	@Test func urgentAsksComeFirstWithinNeedsYou() async {
		let (store, source, _, _) = make()
		var blocked = decisionCard("blocked", attention: 1)
		blocked.status = "blocked"
		var due = decisionCard("due", attention: 2)
		due.mention?.decision?.summary = "It is due 15 Oct."
		source.feed = .success([decisionCard("plain", attention: 9), due, blocked])
		await store.load()
		#expect(store.entries.map(\.id) == ["blocked", "due", "plain"])
		#expect(store.entries[0].urgency?.kind == .blocking)
		#expect(store.entries[1].urgency?.text == "Due 15 Oct")
		#expect(store.entries[2].urgency == nil)
	}

	@Test func theAgentWhoDidTheWorkIsCredited() async {
		let (store, source, _, _) = make()
		source.feed = .success([decisionCard("a")])
		await store.load()
		#expect(store.agent(of: store.entries[0].card)?.name == "Forge")
		source.actors = [ForYouActor(id: "agent-1", name: "Mette", isAgent: false)]
		await store.load()
		#expect(store.agent(of: store.entries[0].card) == nil)
	}

	@Test func takeSuggestedReportsWhatItTookAndSkippedAndOneUndoTakesItBack() async {
		let (store, source, backend, _) = make(window: 5)
		source.feed = .success([decisionCard("a"), decisionCard("b"), destructiveCard("c")])
		await store.load()
		#expect(store.suggestedOptionCount == 2)
		#expect(store.suggestedSkipCount == 1)
		let batch = store.takeSuggestedOptions()
		#expect(batch.taken.map(\.id).sorted() == ["a", "b"])
		#expect(batch.skipped == 1)
		#expect(batch.summary == "2 suggested calls taken \u{00B7} 1 still needs you")
		#expect(store.needsCount == 1)
		store.undo(batch)
		#expect(store.needsCount == 3)
		try? await Task.sleep(for: .milliseconds(100))
		#expect(backend.calls.isEmpty)
	}

	@Test func caughtUpNamesTheAgentsNowCarryingOn() async {
		let (store, source, _, _) = make(window: 5)
		source.feed = .success([decisionCard("a")])
		await store.load()
		#expect(store.caughtUpDetail.hasPrefix("Nothing needs you right now."))
		store.choose(store.entries[0].card.decision!.options[0], on: store.entries[0].card)
		#expect(store.caughtUpDetail == "Your calls are in motion with Forge. You\u{2019}ll hear when one needs you again.")
	}

	@Test func loadsTheBrief() async {
		let (store, _, _, _) = make()
		await store.loadBrief()
		#expect(store.brief == .loaded(ForYouBrief(markdown: "# Brief\nAll quiet.")))
	}
}
