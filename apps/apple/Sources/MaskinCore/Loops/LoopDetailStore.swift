import Foundation
import Observation

/// One loop on its detail screen: the summary, its step pipeline, recent activity, and pause/resume.
@MainActor
@Observable
public final class LoopDetailStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var loop: LoopSummary
	public private(set) var steps: [LoopStep] = []
	public private(set) var activity: [LoopActivityEntry] = []
	public private(set) var overview: LoopOverview = .empty
	/// The newest runs of the flow's steps; empty until read, and when the read fails.
	public private(set) var runs: [LoopRun] = []
	/// The loop's custom views, in tab order; empty until read, and when the loop has none. A failed
	/// read keeps the views already shown.
	public private(set) var views: [LoopView] = []
	/// The phase the viewer tapped; nil follows the busiest one.
	public var selectedStatus: String?
	public private(set) var phase: Phase = .idle
	/// The parts of the screen that load on their own. One that fails, or stays unanswered for
	/// `giveUpAfter`, says so with Try again while the rest of the screen stays.
	public enum Block: Sendable, Hashable {
		case description, steps, activity

		/// What the block says in place of its content. Same words as the web loop page.
		public var message: String {
			switch self {
			case .description: "Couldn't load the description and activity. The server may be busy."
			case .steps: "Couldn't load the steps of this loop. The server may be busy."
			case .activity: "Couldn't load the loop's recent activity. The server may be busy."
			}
		}
	}
	/// The blocks whose last read failed or timed out. Cleared by the next read that succeeds.
	public private(set) var failedBlocks: Set<Block> = []
	/// A Try again is running.
	public private(set) var isRetrying = false
	public private(set) var directory: ActorDirectory
	public private(set) var isTogglingPause = false
	/// The loop no longer exists (deleted elsewhere).
	public private(set) var isGone = false
	public var notice: String?

	@ObservationIgnored private let api: any LoopsAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	@ObservationIgnored private let debouncer: RefreshDebouncer
	@ObservationIgnored private var intents = IntentKeys()
	@ObservationIgnored private let giveUpAfter: Duration

	/// How long a read may stay unanswered before its block says so. Cloudflare gives up at 100 s.
	public nonisolated static let defaultGiveUpAfter: Duration = .seconds(30)

	public init(
		loop: LoopSummary, directory: ActorDirectory = ActorDirectory(), api: any LoopsAPI,
		events: EventHub?, giveUpAfter: Duration = LoopDetailStore.defaultGiveUpAfter
	) {
		self.loop = loop
		self.directory = directory
		self.api = api
		self.events = events
		self.giveUpAfter = giveUpAfter
		self.debouncer = RefreshDebouncer()
	}

	/// Test seam: a custom wait between a live event and the refetch it causes.
	init(
		loop: LoopSummary, api: any LoopsAPI, events: EventHub?, debounce: Duration,
		sleep: @escaping RefreshDebouncer.Sleep
	) {
		self.loop = loop
		self.directory = ActorDirectory()
		self.api = api
		self.events = events
		self.giveUpAfter = Self.defaultGiveUpAfter
		self.debouncer = RefreshDebouncer(delay: debounce, sleep: sleep)
	}

	public func failed(_ block: Block) -> Bool { failedBlocks.contains(block) }

	/// The flow's driver, when the loop has one and the directory knows its name.
	public var driver: (id: String, name: String)? {
		guard let id = overview.driverID, let name = directory.name(id) else { return nil }
		return (id, name)
	}

	public var posts: [LoopPost] { overview.posts }
	public var outputs: [LoopOutput] { overview.outputs }

	public var phases: [LoopPhase] {
		LoopPhases.build(members: overview.members, steps: steps, statusOrder: overview.statusOrder)
	}

	/// The tapped phase, else the first with objects in it, else the first.
	public var selectedPhase: LoopPhase? {
		let all = phases
		if let selectedStatus, let hit = all.first(where: { $0.status == selectedStatus }) { return hit }
		return all.first(where: { $0.count > 0 }) ?? all.first
	}

	/// Steps no phase claims (cron and webhook triggers, or events with no `from_status`).
	public var unphasedSteps: [LoopStep] {
		let claimed = Set(phases.flatMap { $0.steps.map(\.triggerID) })
		return steps.filter { !claimed.contains($0.triggerID) }
	}

	/// One line for the header: how the loop is doing right now.
	public var verdict: String {
		if loop.status == .draft { return "Not running yet" }
		if loop.isPaused { return "Paused" }
		let failed = activity.prefix(10).filter { $0.tone == .failure }.count
		var parts: [String] = []
		if loop.waitingCount > 0 { parts.append("\(loop.waitingCount) \(loop.waitingCount == 1 ? "needs" : "need") you") }
		if failed > 0 { parts.append("\(failed) recent failure\(failed == 1 ? "" : "s")") }
		if parts.isEmpty { parts.append("Healthy") }
		parts.append("\(loop.inProgressCount) in progress")
		return parts.joined(separator: " · ")
	}

	/// The one thing wrong with the flow right now, if anything (the stuck banner).
	public func problem(now: Date = Date()) -> FlowProblem? {
		// Unknown is not stuck: with the steps or the activity unread, there is nothing to judge.
		guard !failed(.steps), !failed(.activity) else { return nil }
		return FlowProblems.derive(
			loop: loop, steps: steps, activity: activity, runs: runs, posts: posts, now: now)
	}

	/// Steps that failed in the last seven days, for the Quality tile.
	public func failedSteps(now: Date = Date()) -> Int { FlowHealth.failedCount(activity, now: now) }

	/// Who an activity entry belongs to, by name.
	public func actorName(_ entry: LoopActivityEntry) -> String? { directory.name(entry.actorID) }

	public func start() async {
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected: await self.refresh()
					case .event(let e) where LoopsStore.affectsLoops(e.entityType):
						await self.scheduleRefresh()
					default: break
					}
				}
			}
		}
		if directory.byID.isEmpty, let actors = try? await api.actors() {
			directory = ActorDirectory(actors)
		}
		await refresh()
	}

	public func stop() {
		listener?.cancel()
		listener = nil
		debouncer.cancel()
	}

	/// A burst of events becomes one reload (each reload is a handful of requests).
	private func scheduleRefresh() {
		debouncer.schedule { [weak self] in await self?.refresh() }
	}

	/// Try again on a block: reads the screen again, and tells the view while it does.
	public func retry() async {
		guard !isRetrying else { return }
		isRetrying = true
		defer { isRetrying = false }
		await refresh()
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
			let hadContent = !(steps.isEmpty && activity.isEmpty)
			if !hadContent { phase = .loading }
			let id = loop.id, triggerIDs = loop.triggerIDs, reads = api, limit = giveUpAfter
			async let summaries = Self.bounded(after: limit) { try await reads.loops() }
			async let stepRows = Self.bounded(after: limit) { try await reads.steps(loopID: id) }
			async let feed = Self.bounded(after: limit) { try await reads.activity(loopID: id) }
			async let extra = Self.bounded(after: limit) { try await reads.overview(loopID: id) }
			async let runRows = Self.bounded(after: limit) { try await reads.runs(triggerIDs: triggerIDs) }
			async let viewRows = Self.bounded(after: limit) { try await reads.views(loopID: id) }
			let (all, newSteps, newFeed) = await (summaries, stepRows, feed)
			if let fresh = try? await extra.get() { overview = fresh }
			// A failed read keeps the runs already on screen; the stuck check just has less to go on.
			if let fresh = try? await runRows.get() { runs = fresh }
			if let fresh = try? await viewRows.get() { views = fresh }

			// Each block keeps what it already shows when its own read fails.
			var blocks: Set<Block> = []
			var firstError: Error?
			switch all {
			case .success(let rows):
				guard let fresh = rows.first(where: { $0.id == id }) else {
					isGone = true
					return
				}
				if !isTogglingPause { loop = fresh }
			case .failure(let error):
				blocks.insert(.description)
				firstError = firstError ?? error
			}
			switch newSteps {
			case .success(let rows): steps = rows
			case .failure(let error):
				blocks.insert(.steps)
				firstError = firstError ?? error
			}
			switch newFeed {
			case .success(let rows): activity = rows
			case .failure(let error):
				blocks.insert(.activity)
				firstError = firstError ?? error
			}
			failedBlocks = blocks
			if let firstError, !hadContent {
				phase = .failed(AutomationError.message(firstError))
			} else {
				phase = .loaded
			}
		} while refreshQueued
	}

	/// The read's answer, or a failure once `limit` passes without one. The read is cancelled at
	/// that point (a Try again starts a new one), so nothing keeps running behind the message.
	private nonisolated static func bounded<T: Sendable>(
		after limit: Duration, _ read: @escaping @Sendable () async throws -> T
	) async -> Result<T, Error> {
		await withTaskGroup(of: Result<T, Error>.self) { group in
			group.addTask {
				do { return .success(try await read()) } catch { return .failure(error) }
			}
			group.addTask {
				do {
					try await Task.sleep(for: limit)
					return .failure(AutomationError("The server may be busy."))
				} catch {
					return .failure(error)
				}
			}
			let first = await group.next() ?? .failure(AutomationError("The server may be busy."))
			group.cancelAll()
			return first
		}
	}

	public func togglePause() async { await set(status: loop.toggledStatus) }

	/// Moves a running flow to another stage (Learning, Supervised, Autonomous); the Status pill
	/// follows at once and rolls back if the server refuses.
	public func setStage(_ stage: LoopStage) async {
		guard loop.status.isLive, loop.status != stage.status else { return }
		await set(status: stage.status)
	}

	private func set(status target: LoopPill) async {
		guard !isTogglingPause else { return }
		let before = loop
		loop = before.with(status: target)
		isTogglingPause = true
		defer { isTogglingPause = false }
		let intent = "status:\(loop.id):\(target.rawValue)"
		do {
			try await api.setStatus(loopID: loop.id, status: target, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
		} catch {
			loop = loop.with(status: before.status)
			let what = target == .paused ? "pause" : before.isPaused ? "resume" : "change the stage of"
			notice = "Couldn't \(what) this flow. \(AutomationError.message(error))"
		}
	}

	/// Called after the server confirmed a delete, so the list can drop the row.
	@ObservationIgnored public var onDeleted: ((String) -> Void)?

	/// Saves a new name and/or description (optimistic, rolled back if the server refuses).
	@discardableResult
	public func save(name: String, content: String) async -> Bool {
		let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
		let body = content.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !title.isEmpty else {
			notice = "A flow needs a name."
			return false
		}
		let newName: String? = title == loop.name ? nil : title
		let newContent: String? = body == (loop.content ?? "") ? nil : body
		guard newName != nil || newContent != nil else { return true }
		let before = loop
		loop.name = title
		loop.content = body.isEmpty ? nil : body
		let intent = "edit:\(loop.id):\(title)\n\(body)"
		do {
			try await api.updateLoop(
				loopID: loop.id, name: newName, content: newContent,
				idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			return true
		} catch {
			loop.name = before.name
			loop.content = before.content
			notice = "Couldn't save your changes. \(AutomationError.message(error))"
			return false
		}
	}

	/// Deletes the loop; on success `isGone` flips so the screen leaves.
	public func delete() async {
		do {
			try await api.deleteLoop(loopID: loop.id)
			isGone = true
			onDeleted?(loop.id)
		} catch {
			notice = "Couldn't delete this flow. \(AutomationError.message(error))"
		}
	}
}
