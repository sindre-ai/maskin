import Foundation
import Observation

/// How the feed is laid out and ordered (the web's view menu).
public struct ForYouDisplayOptions: Sendable, Equatable, Codable {
	public enum Mode: String, Sendable, Codable, CaseIterable { case cards, list }
	public enum Sort: String, Sendable, Codable, CaseIterable {
		/// The sender's attention score first, then latest activity.
		case attention
		/// Latest activity first.
		case latest
	}

	public var mode: Mode = .cards
	public var sort: Sort = .attention
	/// Show only this kind of ask. Nil is "All".
	public var intent: ForYouIntent?
	/// The intent pills under the briefs row are showing (the menu's Filter).
	public var filterBarOn = false
	/// The HANDLED TODAY list at the bottom (the menu's Show handled).
	public var showsHandled = true

	public init(
		mode: Mode = .cards, sort: Sort = .attention, intent: ForYouIntent? = nil,
		filterBarOn: Bool = false, showsHandled: Bool = true
	) {
		self.mode = mode
		self.sort = sort
		self.intent = intent
		self.filterBarOn = filterBarOn
		self.showsHandled = showsHandled
	}

	// Hand-written so options saved before these existed (with a `typeFilter`) still decode.
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		mode = try c.decodeIfPresent(Mode.self, forKey: .mode) ?? .cards
		sort = try c.decodeIfPresent(Sort.self, forKey: .sort) ?? .attention
		intent = try c.decodeIfPresent(ForYouIntent.self, forKey: .intent)
		filterBarOn = try c.decodeIfPresent(Bool.self, forKey: .filterBarOn) ?? false
		showsHandled = try c.decodeIfPresent(Bool.self, forKey: .showsHandled) ?? true
	}
}

/// The four buckets the feed orders by, rendered without headings: the order is the grouping.
public enum FeedBucket: Int, Sendable, Comparable, CaseIterable {
	/// A person has to answer or decide.
	case needs
	/// The ball is with an agent (you answered last).
	case waiting
	/// Nothing to decide, just new activity.
	case fyi
	/// Handled in this sitting: the receipt strip.
	case done

	public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
}

public struct FeedEntry: Identifiable, Sendable, Equatable {
	public var card: ForYouCard
	public var bucket: FeedBucket
	public var record: DecisionRecord?
	/// The reader deferred it and it has come due: the card says "Back again".
	public var backFromLater: Bool
	/// The one chip saying why it sits where it does.
	public var urgency: ForYouUrgency?
	public var id: String { card.id }

	/// Where the card sits in the list. A decided card leaves the open list the moment it is
	/// decided (it lands in HANDLED TODAY with its Undo), so the next ask moves up under the thumb.
	public var section: FeedBucket { bucket }

	public init(
		card: ForYouCard, bucket: FeedBucket, record: DecisionRecord? = nil,
		backFromLater: Bool = false, urgency: ForYouUrgency? = nil
	) {
		self.card = card
		self.bucket = bucket
		self.record = record
		self.backFromLater = backFromLater
		self.urgency = urgency
	}
}

/// What "Take every suggested" did.
public struct SuggestedBatch: Equatable, Sendable {
	/// Cards that got their recommended option.
	public var taken: [ForYouCard]
	/// Asks left for the reader because their recommended option needs a confirmation or there is none.
	public var skipped: Int

	public var summary: String {
		"\(taken.count) suggested \(taken.count == 1 ? "call" : "calls") taken"
			+ (skipped > 0 ? " \u{00B7} \(skipped) still need\(skipped == 1 ? "s" : "") you" : "")
	}
}

public enum BriefState: Sendable, Equatable {
	case idle
	case loading
	case loaded(ForYouBrief)
	case failed(String)
}

/// The For You feed: loads the unread-mentions feed, refreshes on live events, overlays the
/// reader's own decisions (optimistic, via `DecisionService`) and orders it into buckets.
@MainActor
@Observable
public final class ForYouStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	public private(set) var phase: Phase = .idle
	/// A pull-to-refresh is in flight (the list stays on screen).
	public private(set) var isRefreshing = false
	/// A server fetch is in flight. The list uses it to apply what comes back without animating,
	/// so a reorder from fresh data doesn't look like the reader's own action.
	public private(set) var isFetching = false
	/// Cards as the server lists them, before the reader's decisions are overlaid.
	public private(set) var cards: [ForYouCard] = []
	public private(set) var actors: [String: ForYouActor] = [:]
	public private(set) var brief: BriefState = .idle
	/// How current the cards on screen are (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()
	public var options: ForYouDisplayOptions {
		didSet { if options != oldValue { persistOptions() } }
	}

	public let decisions: DecisionService
	/// Editing and approving drafts from the feed; nil where the runtime did not build one.
	public var reviews: DraftReviewStore?
	/// Cards approved from a group this sitting. They stay in it as "Approved" rows.
	public private(set) var groupApprovedIds: Set<String> = []
	/// Cards the reader deferred with Later (device-local).
	public let later: LaterStore
	/// Cards the reader has been shown. A card the server adds afterwards waits behind the
	/// "N new" pill instead of landing above the thumb.
	public private(set) var shownIds: Set<String> = []

	/// The workspace schema's display names by object type key, for card footers and the filter.
	public var typeDisplayNames: [String: String] = [:]

	/// "Bet", "Flow", "Meeting note": the schema's name for a type, never the raw key.
	public func typeLabel(for type: String) -> String {
		ForYouTypeLabel.label(for: type, displayNames: typeDisplayNames)
	}

	/// Cards the reader has acted on this sitting. The server drops them from the feed once the
	/// thread is read, but the receipt stays in place until the next workspace change.
	@ObservationIgnored private var retained: [String: ForYouCard] = [:]
	@ObservationIgnored private let source: any ForYouSource
	@ObservationIgnored private let workspaceId: @MainActor () -> String?
	@ObservationIgnored private let defaults: UserDefaults
	@ObservationIgnored private var loadedWorkspace: String?
	/// Bumped for every fetch (and on workspace change / stop), so only the latest response may
	/// write `cards`: an older, slower one must not overwrite a newer result.
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var hasReportedNetworkContent = false
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var debounce: Task<Void, Never>?
	@ObservationIgnored private let eventDebounce: Duration
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let now: @Sendable () -> Date
	/// Tells the home/lock-screen widgets the feed or a decision changed. No-op unless the runtime
	/// installs the real (debounced) one.
	@ObservationIgnored public var widgetReloader: any WidgetReloader = NoopWidgetReloader()
	private static let optionsKey = "foryou.displayOptions.v1"

	public init(
		source: any ForYouSource, decisions: DecisionService,
		workspaceId: @escaping @MainActor () -> String?, defaults: UserDefaults = .standard,
		eventDebounce: Duration = .milliseconds(350), cache: SnapshotCache? = nil,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.cache = cache
		self.now = now
		self.later = LaterStore(defaults: defaults, workspaceId: workspaceId, now: now)
		self.source = source
		self.decisions = decisions
		self.workspaceId = workspaceId
		self.defaults = defaults
		self.eventDebounce = eventDebounce
		if let data = defaults.data(forKey: Self.optionsKey),
			let saved = try? JSONDecoder().decode(ForYouDisplayOptions.self, from: data)
		{
			options = saved
		} else {
			options = ForYouDisplayOptions()
		}
		// First frame shows the last-known feed; `load()` then revalidates it.
		if let ws = workspaceId() { hydrate(workspace: ws) }
	}

	/// What `ForYouStore` keeps on disk: the feed and the names its cards need, nothing else
	/// (decisions in flight and the brief are never cached).
	struct Snapshot: Codable, Sendable {
		var cards: [ForYouCard]
		var actors: [ForYouActor]
	}
	static let cacheName = "foryou.feed"
	static let cacheLimit = 100

	/// Fill the feed from disk when it is empty. A no-op without a cache or an entry.
	private func hydrate(workspace ws: String) {
		guard cards.isEmpty, let entry = cache?.read(Snapshot.self, Self.cacheName) else { return }
		cards = entry.value.cards
		shownIds = Set(entry.value.cards.map(\.id))
		actors = Dictionary(entry.value.actors.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
		phase = .loaded
		Perf.event("foryou.content.cache")
		loadedWorkspace = ws
		freshness.hydrated(from: entry.savedAt)
	}

	private func persist() {
		cache?.write(
			Snapshot(cards: Array(cards.prefix(Self.cacheLimit)), actors: Array(actors.values)),
			Self.cacheName)
	}

	deinit {
		listener?.cancel()
		debounce?.cancel()
	}

	/// Stop following the event hub; in-flight work is dropped by the generation guard.
	public func stop() {
		listener?.cancel()
		listener = nil
		debounce?.cancel()
		debounce = nil
		generation += 1
	}

	// MARK: Live updates

	/// Subscribe to the event hub once: relevant events refetch (debounced), a reconnect reloads.
	public func start(events hub: EventHub?) {
		guard listener == nil, let hub else { return }
		let signals = hub.subscribe()
		listener = Task { [weak self] in
			for await signal in signals {
				guard let self else { return }
				switch signal {
				case .event(let event):
					if Self.isRelevant(event) { self.scheduleRefresh() }
				case .reconnected:
					await self.refresh(revealingNew: false)
				}
			}
		}
	}

	/// Mentions arrive as comments on objects and as notifications; everything else is noise.
	static func isRelevant(_ event: WorkspaceEvent) -> Bool {
		event.entityType == .object || event.entityType == .notification
	}

	private func scheduleRefresh() {
		debounce?.cancel()
		debounce = Task { [weak self, eventDebounce] in
			try? await Task.sleep(for: eventDebounce)
			guard !Task.isCancelled else { return }
			await self?.refresh(revealingNew: false)
		}
	}

	// MARK: Loading

	/// Initial load (or workspace change). Shows the loading state only when there is nothing yet.
	public func load() async {
		guard let ws = workspaceId() else { return }
		if loadedWorkspace != ws {
			cards = []
			shownIds = []
			later.reload()
			retained = [:]
			groupApprovedIds = []
			reviews?.reset()
			actors = [:]
			brief = .idle
			phase = .idle
			freshness.reset()
			loadedWorkspace = ws
			generation += 1  // anything still in flight belongs to the previous workspace
			hydrate(workspace: ws)
		}
		if cards.isEmpty { phase = .loading }
		await Perf.measure("foryou.load") { await fetch(workspace: ws) }
	}

	/// Pull-to-refresh and event-driven refetch. Keeps what is on screen; a failure while the
	/// feed is already showing is swallowed rather than replacing cards with an error.
	///
	/// `revealingNew: false` is for live updates: an ask that arrives while the reader is looking
	/// at the list waits behind the "N new" pill (`pendingNewCount`) instead of pushing the card
	/// under their thumb down. Pull-to-refresh is the reader asking, so it shows everything.
	public func refresh(revealingNew: Bool = true) async {
		guard let ws = workspaceId() else { return }
		if loadedWorkspace != ws {
			await load()
			return
		}
		isRefreshing = true
		defer { isRefreshing = false }
		await fetch(workspace: ws, revealingNew: revealingNew)
	}

	/// Brings the asks that arrived while reading into the list (the "N new · Show" pill).
	public func showNew() {
		shownIds = Set(cards.map(\.id))
	}

	/// Asks the server added since the reader last looked.
	public var pendingNewCount: Int {
		cards.filter { isOpenCandidate($0) && !shownIds.contains($0.id) }.count
	}

	private func isOpenCandidate(_ card: ForYouCard) -> Bool {
		card.unreadCount > 0 && card.objectType != "onboarding_session"
	}

	private func fetch(workspace ws: String, revealingNew: Bool = true) async {
		generation += 1
		let mine = generation
		isFetching = true
		defer { if mine == generation { isFetching = false } }
		let started = ContinuousClock.now
		async let actorsResult = try? source.fetchActors(workspaceId: ws)
		var succeeded = false
		do {
			let fetched = try await source.fetchFeed(workspaceId: ws)
			guard mine == generation, workspaceId() == ws else { return }
			cards = fetched
			if revealingNew || entries.isEmpty { shownIds = Set(fetched.map(\.id)) }
			if !hasReportedNetworkContent {
				hasReportedNetworkContent = true
				Perf.event("foryou.content.network")
			}
			phase = .loaded
			freshness.refreshed(at: cache?.now() ?? Date())
			later.prune(keeping: Set(fetched.map(\.id)))
			succeeded = true
		} catch {
			guard mine == generation, workspaceId() == ws else { return }
			// A failed revalidate never blanks good data: only an empty feed shows the error.
			if cards.isEmpty { phase = .failed(Self.message(for: error)) }
			freshness.revalidateFailed()
		}
		SyncLog.revalidated(Self.cacheName, ok: succeeded, since: started)
		if succeeded, mine == generation { widgetReloader.reload() }
		if let list = await actorsResult, mine == generation, workspaceId() == ws {
			actors = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
		}
		if succeeded, mine == generation, workspaceId() == ws { persist() }
	}

	public func loadBrief() async {
		guard let ws = workspaceId() else { return }
		if case .loading = brief { return }
		brief = .loading
		do {
			let loaded = try await source.fetchBrief(workspaceId: ws)
			guard workspaceId() == ws else { return }
			brief = .loaded(loaded)
		} catch {
			brief = .failed(Self.message(for: error))
		}
	}

	static func message(for error: any Error) -> String {
		if let e = error as? ForYouLoadError { return e.message }
		if error is URLError { return "You appear to be offline." }
		return "Something went wrong loading your feed."
	}

	// MARK: Acting (thin wrappers that keep the card on screen)

	/// Take an option on a card.
	public func choose(_ option: DecisionOption, note: String? = nil, on card: ForYouCard) {
		if isSendHeldBack(option, on: card) { return }
		retain(card)
		later.clear(card.id)
		decisions.choose(option.label, note: note, on: DecisionTarget(card))
		widgetReloader.reload()
	}

	/// Send or skip one message of a card that carries several. The card stays on screen: it
	/// settles when the view has seen every message dealt with (then it calls `dismiss`).
	/// Returns false when the reply could not be queued.
	@discardableResult
	public func actOnDraft(
		_ draft: DecisionDraft, action: DecisionService.DraftAction, on card: ForYouCard
	) -> Bool {
		retain(card)
		later.clear(card.id)
		let queued = decisions.actOnDraft(
			action, label: draft.label, to: draft.to, id: draft.id, on: DecisionTarget(card))
		if queued { widgetReloader.reload() }
		return queued
	}

	public func reply(_ text: String, on card: ForYouCard) {
		retain(card)
		later.clear(card.id)
		decisions.reply(text, on: DecisionTarget(card))
		widgetReloader.reload()
	}

	public func dismiss(_ card: ForYouCard) {
		retain(card)
		later.clear(card.id)
		decisions.markRead(DecisionTarget(card))
		widgetReloader.reload()
	}

	/// Take back the last action on a card (inside the Undo window, or a sent dismissal).
	@discardableResult
	public func undo(_ card: ForYouCard) -> Bool {
		let undone = decisions.undo(card.id)
		if undone { widgetReloader.reload() }
		return undone
	}

	/// Defer a card to a preset time. Returns what to hand `undoLater` to take it back.
	@discardableResult
	public func deferCard(_ card: ForYouCard, to preset: LaterPreset) -> LaterEntry? {
		let previous = later.entry(for: card.id)
		later.defer(card.id, preset: preset)
		widgetReloader.reload()
		return previous
	}

	/// Take a deferral back (the toast's Undo): the card returns to the open list.
	public func undoLater(_ card: ForYouCard, restoring previous: LaterEntry?) {
		later.restore(card.id, to: previous)
		widgetReloader.reload()
	}

	/// "Bring back" on a LATER row.
	public func bringBack(_ card: ForYouCard) {
		later.clear(card.id)
		widgetReloader.reload()
	}

	/// Dismiss every FYI at once; each is individually undoable.
	public func dismissAllFYIs() {
		for entry in entries where entry.bucket == .fyi { dismiss(entry.card) }
	}

	/// The recommended option on every open decision, in one go. Options that can't be undone are
	/// left for the reader: like the swipe, this never takes one. Each stays individually
	/// undoable, and the returned batch is what a single Undo takes back.
	@discardableResult
	public func takeSuggestedOptions() -> SuggestedBatch {
		var batch = SuggestedBatch(taken: [], skipped: 0)
		for entry in entries where entry.bucket == .needs && entry.card.kind == .decision {
			if let option = entry.card.decision?.recommended, !option.destructive,
				!isSendHeldBack(option, on: entry.card)
			{
				choose(option, on: entry.card)
				batch.taken.append(entry.card)
			} else {
				batch.skipped += 1
			}
		}
		return batch
	}

	/// Takes back every card of a batch.
	public func undo(_ batch: SuggestedBatch) {
		for card in batch.taken { _ = undo(card) }
	}

	/// How many decisions `takeSuggestedOptions()` would act on, and how many it would leave.
	public var suggestedOptionCount: Int { suggestedCounts.take }
	public var suggestedSkipCount: Int { suggestedCounts.skip }

	private var suggestedCounts: (take: Int, skip: Int) {
		var take = 0
		var skip = 0
		for entry in entries where entry.bucket == .needs && entry.card.kind == .decision {
			if let option = entry.card.decision?.recommended, !option.destructive { take += 1 } else { skip += 1 }
		}
		return (take, skip)
	}

	private func retain(_ card: ForYouCard) { retained[card.id] = card }

	// MARK: Derived

	public func actorName(_ id: String?) -> String? {
		guard let id else { return nil }
		return actors[id]?.name
	}

	/// Who raised the card.
	public func senderName(of card: ForYouCard) -> String? { actorName(card.mention?.actorId) }

	/// The agent that did the work, for the "with {agent}" credit: the one who raised the card,
	/// when that is an agent. Nil for a person.
	public func agent(of card: ForYouCard) -> ForYouActor? {
		guard let id = card.mention?.actorId, let actor = actors[id], actor.isAgent else { return nil }
		return actor
	}

	/// The ordered feed: decisions first (blocking, then due, then the rest), then what waits on an
	/// agent, then FYIs, then what has been handled. Stable within a rank. Cards the reader
	/// deferred and asks still behind the "N new" pill are not here.
	public var entries: [FeedEntry] { build(deferred: false) }

	/// Cards deferred with Later and not yet due, in the order they come back.
	public var laterEntries: [FeedEntry] {
		build(deferred: true)
			.sorted { (later.entry(for: $0.id)?.until ?? .distantFuture) < (later.entry(for: $1.id)?.until ?? .distantFuture) }
	}

	private func build(deferred wantDeferred: Bool, ignoringIntent: Bool = false) -> [FeedEntry] {
		var byId: [String: ForYouCard] = [:]
		for card in cards where isOpenCandidate(card) && shownIds.contains(card.id) {
			byId[card.id] = card
		}
		var ordered = sorted(Array(byId.values))
		// Cards the reader acted on that the server has already dropped.
		let extra = retained.values.filter { byId[$0.id] == nil && decisions.record(for: $0.id) != nil }
		ordered += sorted(Array(extra))

		let intent = ignoringIntent ? nil : options.intent
		let at = now()
		return ordered.compactMap { card -> (entry: FeedEntry, slot: FeedBucket, rank: Int)? in
			let record = decisions.record(for: card.id)
			let isDeferred = record == nil && later.isDeferred(card.id)
			guard isDeferred == wantDeferred else { return nil }
			let bucket = bucket(for: card, record: record)
			let urgency = bucket == .needs || bucket == .fyi
				? ForYouUrgency.make(for: card, agent: senderName(of: card), now: at) : nil
			if let intent, bucket != .done, !intent.matches(card, urgency: urgency) { return nil }
			let entry = FeedEntry(
				card: card, bucket: bucket, record: record,
				backFromLater: record == nil && later.isBackFromLater(card.id), urgency: urgency)
			// A card from the Chief of Staff's list keeps that order; urgency only orders the rest.
			return (entry, bucket, bucket == .needs && card.rank == nil ? ForYouUrgency.rank(of: urgency) : 0)
		}
		.enumerated()
		.sorted { ($0.element.slot, $0.element.rank, $0.offset) < ($1.element.slot, $1.element.rank, $1.offset) }
		.map(\.element.entry)
	}

	private func bucket(for card: ForYouCard, record: DecisionRecord?) -> FeedBucket {
		if let record {
			switch (record.kind, record.phase) {
			case (_, .failed): break  // rolled back: the card is as it was
			case (.reply, _): return .waiting
			default: return .done
			}
		}
		return card.kind == .decision ? .needs : .fyi
	}

	private func sorted(_ list: [ForYouCard]) -> [ForYouCard] {
		// The Chief of Staff's ranking wins over the reader's sort setting; cards without a rank
		// (none come from the server today, but a cached card might) follow it.
		if list.contains(where: { $0.rank != nil }) {
			return list.sorted { ($0.rank ?? .max) < ($1.rank ?? .max) }
		}
		let latest: (ForYouCard, ForYouCard) -> Bool = {
			($0.latestActivityAt ?? .distantPast) > ($1.latestActivityAt ?? .distantPast)
		}
		switch options.sort {
		case .latest: return list.sorted(by: latest)
		case .attention:
			return list.sorted {
				let a = $0.maxAttention ?? -1
				let b = $1.maxAttention ?? -1
				return a != b ? a > b : latest($0, $1)
			}
		}
	}

	// MARK: Header

	/// "SUN 18 OCT" for the line above the title.
	public func dateLine(at date: Date? = nil) -> String { ForYouHeader.dateLine(date ?? now()) }

	/// The same day, written for VoiceOver.
	public func spokenDate(at date: Date? = nil) -> String { ForYouHeader.spokenDate(date ?? now()) }

	/// The one sentence under the title: what is blocked on the reader. It looks past the intent
	/// filter, which only narrows the list below.
	public var blockedSummary: String? {
		let blocking = build(deferred: false, ignoringIntent: true).filter { $0.bucket == .needs }
		return ForYouHeader.summary(
			blocking: blocking, loaded: phase == .loaded,
			sender: { [self] in agent(of: $0)?.name ?? senderName(of: $0) })
	}

	// MARK: Groups

	/// The "Needs you" list with related approvals folded into groups.
	public var needsItems: [FeedItem] {
		// A finished group is a receipt with Undo. Once no card in it can be taken back it has nothing
		// left to offer, and the same cards are in Handled today.
		return ApprovalGrouping.items(
			entries: entries, approvedIds: groupApprovedIds,
			agentName: { [self] in agent(of: $0)?.name ?? senderName(of: $0) }
		).filter { item in
			if case .group(let group) = item, group.isDone { return canUndo(group) }
			return true
		}
	}

	/// Approve one card of a group. It takes the card's own recommended option through the same
	/// path as a single approve, so the audit trail and Undo are the same. False when it could not.
	@discardableResult
	public func approveFromGroup(_ card: ForYouCard) -> Bool {
		guard let option = card.decision?.recommended, !option.destructive,
			ApprovalGrouping.isApprove(option.label)
		else { return false }
		groupApprovedIds.insert(card.id)
		choose(option, on: card)
		return true
	}

	/// Approve every open card of a group, one call per card.
	@discardableResult
	public func approveAll(in group: ApprovalGroup) -> SuggestedBatch {
		var batch = SuggestedBatch(taken: [], skipped: 0)
		for entry in group.openEntries {
			if approveFromGroup(entry.card) { batch.taken.append(entry.card) } else { batch.skipped += 1 }
		}
		return batch
	}

	/// How many approved cards of the group can still be taken back.
	public func undoableCount(_ group: ApprovalGroup) -> Int {
		group.members.filter { $0.isApproved && decisions.canUndo($0.id) }.count
	}

	/// Undo is free while any approved card is still inside its hold.
	public func canUndo(_ group: ApprovalGroup) -> Bool { undoableCount(group) > 0 }

	/// Take back every approved card of a group that can still be taken back.
	public func undo(_ group: ApprovalGroup) {
		for member in group.members where member.isApproved {
			if undo(member.entry.card) { groupApprovedIds.remove(member.id) }
		}
	}

	// MARK: Drafts

	/// Drafts waiting for the reader on open cards, ready to edit and approve. One that has been
	/// approved is a receipt (`reviews.receiptDrafts`), not a draft.
	public var reviewDrafts: [ReviewDraft] {
		guard let reviews else { return [] }
		var seen: Set<String> = []
		var drafts: [ReviewDraft] = []
		for entry in entries where entry.bucket == .needs && entry.record == nil {
			let name = agent(of: entry.card)?.name ?? senderName(of: entry.card)
			for draft in ReviewDraft.drafts(in: entry.card, agentName: name)
			where reviews.isEditable(draft) && seen.insert(draft.id).inserted {
				drafts.append(draft)
			}
		}
		return drafts
	}

	/// Whether this draft is shown in the strip, so its card does not show it a second time.
	public func isInStrip(_ draft: DecisionDraft) -> Bool {
		reviews != nil && ReviewDraft.isReviewable(draft)
	}

	public static let unsentEditNote = "Approve your edited message under Drafts to review"
	public static let sendingEditNote = "Your edited message is being sent under Drafts to review"

	/// Why this card's own Send option is off: a message on the card has an edit that has not gone
	/// out, and the option would send the saved text instead. Nil when nothing is in the way.
	public func unsentEditNote(for card: ForYouCard) -> String? {
		guard let reviews else { return nil }
		var note: String?
		for draft in ReviewDraft.drafts(in: card, agentName: nil) where reviews.isEdited(draft) {
			switch reviews.phase(of: draft) {
			case .editing, .failed: return Self.unsentEditNote
			case .held, .sending: note = Self.sendingEditNote
			case .sent: break
			}
		}
		return note
	}

	/// The option would send the saved text of a message whose edit has not gone out. Taking it
	/// (tap, swipe, Return or "take every suggested") does nothing until the edit is approved.
	public func isSendHeldBack(_ option: DecisionOption, on card: ForYouCard) -> Bool {
		unsentEditNote(for: card) != nil && ReviewDraft.sendsMessage(option)
	}

	/// A draft was approved and the agent told. When it was the last message on its card the card
	/// is settled like any other answered ask.
	func draftSent(_ draft: ReviewDraft) {
		guard let card = cards.first(where: { $0.id == draft.target.entityId }),
			let decision = card.decision
		else { return }
		let all = (decision.draft.map { [$0] } ?? []) + decision.drafts
		let covered = all.filter { $0.objectId != nil && $0.preview != nil && $0.file == nil }
		var sent: Set<String> = []
		for receipt in reviews?.receipts ?? [] where reviews?.phase(of: receipt) == .sent {
			sent.insert(receipt.id)
		}
		let left = covered.contains { d in
			guard let id = d.objectId else { return false }
			return !sent.contains(id) && d.preview?.delivery != .sent
		}
		// A message the strip cannot show (a file) keeps the card open for the reader.
		if left || covered.count != all.count { return }
		dismiss(card)
	}

	/// Asks still open: not decided, held or deferred. This is the tab badge and the "caught up"
	/// test; handled and held cards never count.
	public var unreadCount: Int { entries.filter { $0.bucket == .needs || $0.bucket == .fyi }.count }
	public var needsCount: Int { entries.filter { $0.bucket == .needs }.count }

	/// Open asks per intent, for the filter pills.
	public func intentCount(_ intent: ForYouIntent?) -> Int {
		let at = now()
		return cards.filter { card in
			guard isOpenCandidate(card), shownIds.contains(card.id) else { return false }
			let record = decisions.record(for: card.id)
			guard bucket(for: card, record: record) == .needs || bucket(for: card, record: record) == .fyi,
				!later.isDeferred(card.id)
			else { return false }
			guard let intent else { return true }
			return intent.matches(
				card, urgency: ForYouUrgency.make(for: card, agent: senderName(of: card), now: at))
		}.count
	}

	/// The caught-up line: who is now carrying on because of the reader's calls.
	public var caughtUpDetail: String {
		var names: [String] = []
		for entry in entries where entry.bucket == .done {
			guard case .option = entry.record?.kind, let name = senderName(of: entry.card),
				!names.contains(name)
			else { continue }
			names.append(name)
		}
		guard !names.isEmpty else {
			return "Nothing needs you right now. The flows keep running \u{2014} you\u{2019}ll hear when one does."
		}
		return "Your calls are in motion with \(names.joined(separator: ", ")). You\u{2019}ll hear when one needs you again."
	}

	public var isEmpty: Bool { phase == .loaded && entries.isEmpty }

	private func persistOptions() {
		if let data = try? JSONEncoder().encode(options) { defaults.set(data, forKey: Self.optionsKey) }
	}
}
