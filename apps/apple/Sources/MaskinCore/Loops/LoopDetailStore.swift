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

	/// A burst of events becomes one reload (each reload is three requests).
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
				let (all, newSteps, newFeed) = try await (summaries, stepRows, feed)
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
			notice = "Couldn't \(target == .paused ? "pause" : "resume") this loop. \(AutomationError.message(error))"
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
			notice = "A loop needs a name."
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
			notice = "Couldn't delete this loop. \(AutomationError.message(error))"
		}
	}
}
