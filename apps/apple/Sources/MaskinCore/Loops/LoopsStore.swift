import Foundation
import Observation

/// The Loops list: every loop in the workspace grouped by what needs attention, live updates, and
/// pause/resume (optimistic, rolled back on failure).
@MainActor
@Observable
public final class LoopsStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var loops: [LoopSummary] = []
	public private(set) var phase: Phase = .idle
	public private(set) var directory = ActorDirectory()
	/// Loop object id → install info (only loops installed from the marketplace).
	public private(set) var installs: [String: LoopInstall] = [:]
	public var notice: String?
	/// How current the list on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let api: any LoopsAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	@ObservationIgnored private var inFlight: [String: LoopPill] = [:]

	@ObservationIgnored private let debouncer: RefreshDebouncer
	@ObservationIgnored private var intents = IntentKeys()

	public init(api: any LoopsAPI, events: EventHub?, cache: SnapshotCache? = nil) {
		self.api = api
		self.events = events
		self.debouncer = RefreshDebouncer()
		self.cache = cache
		hydrateIfNeeded()
	}

	/// What the list keeps on disk: the loops and the names their rows resolve.
	struct Snapshot: Codable, Sendable {
		var loops: [LoopSummary]
		var actors: [AutomationActor]
	}
	static let cacheName = "loops.list"

	private func hydrateIfNeeded() {
		guard phase == .idle, loops.isEmpty, let entry = cache?.read(Snapshot.self, Self.cacheName)
		else { return }
		loops = entry.value.loops
		directory = ActorDirectory(entry.value.actors)
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
	}

	private func persist() {
		cache?.write(Snapshot(loops: loops, actors: directory.all), Self.cacheName)
	}

	/// Test seam: a custom wait between a live event and the refetch it causes.
	init(
		api: any LoopsAPI, events: EventHub?, debounce: Duration,
		sleep: @escaping RefreshDebouncer.Sleep, cache: SnapshotCache? = nil
	) {
		self.api = api
		self.events = events
		self.debouncer = RefreshDebouncer(delay: debounce, sleep: sleep)
		self.cache = cache
		hydrateIfNeeded()
	}

	public func loop(id: String) -> LoopSummary? { loops.first { $0.id == id } }

	public func agentNames(for loop: LoopSummary) -> [String] {
		loop.agentIDs.compactMap { directory.name($0) }
	}

	/// Every loop, as the API ordered them, narrowed by the search text.
	public func filtered(query: String = "") -> [LoopSummary] {
		let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
		return loops.filter { text.isEmpty || $0.displayName.localizedCaseInsensitiveContains(text) }
	}

	public var waitingCount: Int { loops.reduce(0) { $0 + $1.waitingCount } }

	/// A loop needs the viewer when it is blocked on them .
	public func needsYou(_ loop: LoopSummary) -> Bool {
		loop.pill == .waitingOnYou || loop.waitingCount > 0
	}

	/// Running loops that need the viewer (a paused loop is not in motion, so it is not counted).
	public var needYouCount: Int { loops.filter { $0.status.isLive && needsYou($0) }.count }

	/// "3 outcomes in motion. 2 need you." Nil when no loop is running.
	public var summaryLine: String? {
		let running = loops.filter { $0.status.isLive }
		guard !running.isEmpty else { return nil }
		let moving = "\(running.count) \(running.count == 1 ? "outcome" : "outcomes") in motion."
		let needs = needYouCount
		guard needs > 0 else { return moving }
		return moving + " \(needs) \(needs == 1 ? "needs" : "need") you."
	}


	// MARK: Loading

	public func start() async {
		hydrateIfNeeded()
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected:
						await self.refresh()
					case .event(let event) where Self.affectsLoops(event.entityType):
						await self.scheduleRefresh()
					default:
						break
					}
				}
			}
		}
		async let names: Void = loadActors()
		async let installed: Void = loadInstalls()
		await refresh()
		await names
		await installed
	}

	/// Loops are objects; their counts move with objects, sessions and triggers.
	static func affectsLoops(_ type: EntityType) -> Bool {
		type == .object || type == .trigger || type == .session || type == .relationship
	}

	public func stop() {
		listener?.cancel()
		listener = nil
		debouncer.cancel()
	}

	/// A burst of events becomes one reload.
	private func scheduleRefresh() {
		debouncer.schedule { [weak self] in await self?.refresh() }
	}

	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			if loops.isEmpty { phase = .loading }
			let started = ContinuousClock.now
			do {
				var fresh = try await api.loops()
				for (id, status) in inFlight {
					if let i = fresh.firstIndex(where: { $0.id == id }) { fresh[i] = fresh[i].with(status: status) }
				}
				loops = fresh
				phase = .loaded
				freshness.refreshed(at: cache?.now() ?? Date())
				SyncLog.revalidated(Self.cacheName, ok: true, since: started)
				persist()
			} catch {
				freshness.revalidateFailed()
				SyncLog.revalidated(Self.cacheName, ok: false, since: started)
				if loops.isEmpty { phase = .failed(AutomationError.message(error)) }
			}
		} while refreshQueued
	}

	public func loadActors() async {
		guard directory.byID.isEmpty else { return }
		if let actors = try? await api.actors() {
			directory = ActorDirectory(actors)
			if phase == .loaded { persist() }
		}
	}

	public func loadInstalls() async {
		guard let rows = try? await api.installs() else { return }
		installs = Dictionary(
			rows.compactMap { row in row.objectID.map { ($0, row) } }, uniquingKeysWith: { a, _ in a })
	}

	// MARK: Writes

	/// Pause a running loop, or resume a paused one. Resuming goes back to `learning` as the web
	/// does; the API does not expose the rung the loop was on before it was paused.
	public func togglePause(_ id: String) async {
		// A second tap while the first is in flight would flip the optimistic state back.
		guard inFlight[id] == nil, let index = loops.firstIndex(where: { $0.id == id }) else { return }
		let before = loops[index]
		let target = before.toggledStatus
		loops[index] = before.with(status: target)
		inFlight[id] = target
		defer { inFlight[id] = nil }
		let intent = "status:\(id):\(target.rawValue)"
		do {
			try await api.setStatus(loopID: id, status: target, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
		} catch {
			// Undo only this loop's status; the rest of the row may have been refreshed meanwhile.
			if let i = loops.firstIndex(where: { $0.id == id }) {
				loops[i] = loops[i].with(status: before.status)
			}
			notice = "Couldn't \(target == .paused ? "pause" : "resume") this loop. \(AutomationError.message(error))"
		}
	}

	/// Creates a loop and puts it in the list straight away; returns its id for navigation.
	/// A retry of the same name/description reuses the idempotency key, so a lost response
	/// cannot create two loops.
	@discardableResult
	public func create(name: String, description: String) async -> String? {
		let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
		let content = description.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !title.isEmpty else { return nil }
		let intent = "create:\(title)\n\(content)"
		do {
			let id = try await api.createLoop(
				name: title, content: content, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			if !loops.contains(where: { $0.id == id }) {
				loops.insert(
					LoopSummary(
						id: id, name: title, content: content.isEmpty ? nil : content, status: .learning),
					at: 0)
				phase = .loaded
			}
			await refresh()
			return id
		} catch {
			notice = "Couldn't create this loop. \(AutomationError.message(error))"
			return nil
		}
	}

	/// Drops a loop locally after the detail screen deleted it on the server.
	public func didDelete(_ id: String) {
		loops.removeAll { $0.id == id }
		persist()
	}
}
