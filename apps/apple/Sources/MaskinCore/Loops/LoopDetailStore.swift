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
	/// The phase the viewer tapped; nil follows the busiest one.
	public var selectedStatus: String?
	public private(set) var phase: Phase = .idle
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

	public init(
		loop: LoopSummary, directory: ActorDirectory = ActorDirectory(), api: any LoopsAPI,
		events: EventHub?
	) {
		self.loop = loop
		self.directory = directory
		self.api = api
		self.events = events
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
		self.debouncer = RefreshDebouncer(delay: debounce, sleep: sleep)
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

	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			if steps.isEmpty && activity.isEmpty { phase = .loading }
			do {
				async let summaries = api.loops()
				async let stepRows = api.steps(loopID: loop.id)
				async let feed = api.activity(loopID: loop.id)
				async let extra = try? api.overview(loopID: loop.id)
				let (all, newSteps, newFeed) = try await (summaries, stepRows, feed)
				if let fresh = await extra { overview = fresh }
				guard let fresh = all.first(where: { $0.id == loop.id }) else {
					isGone = true
					return
				}
				if !isTogglingPause { loop = fresh }
				steps = newSteps
				activity = newFeed
				phase = .loaded
			} catch {
				if steps.isEmpty && activity.isEmpty { phase = .failed(AutomationError.message(error)) }
			}
		} while refreshQueued
	}

	public func togglePause() async {
		guard !isTogglingPause else { return }
		let before = loop
		let target = before.toggledStatus
		loop = before.with(status: target)
		isTogglingPause = true
		defer { isTogglingPause = false }
		let intent = "status:\(loop.id):\(target.rawValue)"
		do {
			try await api.setStatus(loopID: loop.id, status: target, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
		} catch {
			loop = loop.with(status: before.status)
			notice = "Couldn't \(target == .paused ? "pause" : "resume") this flow. \(AutomationError.message(error))"
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
