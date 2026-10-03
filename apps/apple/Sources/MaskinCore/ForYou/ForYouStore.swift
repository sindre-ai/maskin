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
	/// Show only this object type (`bet`, `task`, `insight`…).
	public var typeFilter: String?

	public init(mode: Mode = .cards, sort: Sort = .attention, typeFilter: String? = nil) {
		self.mode = mode
		self.sort = sort
		self.typeFilter = typeFilter
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
	public var id: String { card.id }

	/// Where the card sits in the list. While its undo window is open a decided card keeps the slot
	/// it had, so it is grouped with what it was, not with the receipts.
	public var section: FeedBucket {
		if let record, case .held = record.phase { return card.kind == .decision ? .needs : .fyi }
		return bucket
	}

	public init(card: ForYouCard, bucket: FeedBucket, record: DecisionRecord? = nil) {
		self.card = card
		self.bucket = bucket
		self.record = record
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
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var debounce: Task<Void, Never>?
	@ObservationIgnored private let eventDebounce: Duration
	@ObservationIgnored private let cache: SnapshotCache?
	/// Tells the home/lock-screen widgets the feed or a decision changed. No-op unless the runtime
	/// installs the real (debounced) one.
	@ObservationIgnored public var widgetReloader: any WidgetReloader = NoopWidgetReloader()
	private static let optionsKey = "foryou.displayOptions.v1"

	public init(
		source: any ForYouSource, decisions: DecisionService,
		workspaceId: @escaping @MainActor () -> String?, defaults: UserDefaults = .standard,
		eventDebounce: Duration = .milliseconds(350), cache: SnapshotCache? = nil
	) {
		self.cache = cache
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
		actors = Dictionary(entry.value.actors.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
		phase = .loaded
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
					await self.refresh()
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
			await self?.refresh()
		}
	}

	// MARK: Loading

	/// Initial load (or workspace change). Shows the loading state only when there is nothing yet.
	public func load() async {
		guard let ws = workspaceId() else { return }
		if loadedWorkspace != ws {
			cards = []
			retained = [:]
			actors = [:]
			brief = .idle
			phase = .idle
			freshness.reset()
			loadedWorkspace = ws
			generation += 1  // anything still in flight belongs to the previous workspace
			hydrate(workspace: ws)
		}
		if cards.isEmpty { phase = .loading }
		await fetch(workspace: ws)
	}

	/// Pull-to-refresh and event-driven refetch. Keeps what is on screen; a failure while the
	/// feed is already showing is swallowed rather than replacing cards with an error.
	public func refresh() async {
		guard let ws = workspaceId() else { return }
		if loadedWorkspace != ws {
			await load()
			return
		}
		isRefreshing = true
		defer { isRefreshing = false }
		await fetch(workspace: ws)
	}

	private func fetch(workspace ws: String) async {
		generation += 1
		let mine = generation
		let started = ContinuousClock.now
		async let actorsResult = try? source.fetchActors(workspaceId: ws)
		var succeeded = false
		do {
			let fetched = try await source.fetchFeed(workspaceId: ws)
			guard mine == generation, workspaceId() == ws else { return }
			cards = fetched
			phase = .loaded
			freshness.refreshed(at: cache?.now() ?? Date())
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
	public func choose(_ option: DecisionOption, on card: ForYouCard) {
		retain(card)
		decisions.choose(option.label, on: DecisionTarget(card))
		widgetReloader.reload()
	}

	public func reply(_ text: String, on card: ForYouCard) {
		retain(card)
		decisions.reply(text, on: DecisionTarget(card))
		widgetReloader.reload()
	}

	public func dismiss(_ card: ForYouCard) {
		retain(card)
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

	/// Dismiss every FYI at once; each is individually undoable.
	public func dismissAllFYIs() {
		for entry in entries where entry.bucket == .fyi { dismiss(entry.card) }
	}

	/// The recommended option on every open decision, in one go.
	public func takeSuggestedOptions() {
		for entry in entries where entry.bucket == .needs {
			if let option = entry.card.decision?.recommended { choose(option, on: entry.card) }
		}
	}

	private func retain(_ card: ForYouCard) { retained[card.id] = card }

	// MARK: Derived

	public func actorName(_ id: String?) -> String? {
		guard let id else { return nil }
		return actors[id]?.name
	}

	/// Who raised the card.
	public func senderName(of card: ForYouCard) -> String? { actorName(card.mention?.actorId) }

	/// The ordered feed: decisions first, then what waits on an agent, then FYIs, then what has
	/// been handled. Stable within a bucket.
	public var entries: [FeedEntry] {
		var byId: [String: ForYouCard] = [:]
		for card in cards where card.unreadCount > 0 && card.objectType != "onboarding_session" {
			byId[card.id] = card
		}
		var ordered = sorted(Array(byId.values))
		// Cards the reader acted on that the server has already dropped.
		let extra = retained.values.filter { byId[$0.id] == nil && decisions.record(for: $0.id) != nil }
		ordered += sorted(Array(extra))

		let filter = options.typeFilter
		return ordered.compactMap { card -> (entry: FeedEntry, slot: FeedBucket)? in
			if let filter, card.objectType != filter { return nil }
			let record = decisions.record(for: card.id)
			let entry = FeedEntry(card: card, bucket: bucket(for: card, record: record), record: record)
			// While the undo window is open the card keeps its place and only its options turn
			// into the receipt. It drops to the receipt strip once the choice is committed, so
			// the card under the reader's thumb never jumps away the moment they tap.
			if let record, case .held = record.phase {
				return (entry, card.kind == .decision ? .needs : .fyi)
			}
			return (entry, entry.bucket)
		}
		.enumerated()
		.sorted { ($0.element.slot, $0.offset) < ($1.element.slot, $1.offset) }
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

	/// Cards that still need the reader (decisions awaiting an answer, plus FYIs).
	public var unreadCount: Int { entries.filter { $0.bucket == .needs || $0.bucket == .fyi }.count }
	public var needsCount: Int { entries.filter { $0.bucket == .needs }.count }

	/// Counts per object type across the unread queue, for the filter menu.
	public var typeCounts: [(type: String, count: Int)] {
		var counts: [String: Int] = [:]
		for card in cards where card.unreadCount > 0 {
			if let type = card.objectType, type != "onboarding_session" { counts[type, default: 0] += 1 }
		}
		return counts.map { ($0.key, $0.value) }.sorted { $0.type < $1.type }
	}

	public var isEmpty: Bool { phase == .loaded && entries.isEmpty }

	private func persistOptions() {
		if let data = try? JSONEncoder().encode(options) { defaults.set(data, forKey: Self.optionsKey) }
	}
}
