import Foundation
import Observation

/// What the flow-cycle Live Activity needs from the platform. The app target implements it with
/// ActivityKit; tests use a recording fake.
@MainActor
public protocol CycleActivityHosting: AnyObject {
	func start(flowId: String, workspaceId: String, state: CycleActivityState)
	func update(flowId: String, state: CycleActivityState) async
	func end(flowId: String) async
}

/// Which flows the person asked to follow on the Lock Screen (Notifications → Flows). Per device.
public protocol CycleOptInStorage: Sendable {
	func load() -> Set<String>
	func save(_ ids: Set<String>)
}

public struct UserDefaultsCycleOptInStorage: CycleOptInStorage, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key = "cycle-activity.opted-in-flows"

	public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

	public func load() -> Set<String> { Set(defaults.stringArray(forKey: key) ?? []) }
	public func save(_ ids: Set<String>) { defaults.set(ids.sorted(), forKey: key) }
}

public final class InMemoryCycleOptInStorage: CycleOptInStorage, @unchecked Sendable {
	private var ids: Set<String>
	public init(_ ids: Set<String> = []) { self.ids = ids }
	public func load() -> Set<String> { ids }
	public func save(_ ids: Set<String>) { self.ids = ids }
}

/// Decides, from the flows on screen, which cycle activities to start, update and end. Pure.
public enum CycleActivityPlanner {
	public enum Action: Equatable, Sendable {
		case start(flowId: String, state: CycleActivityState)
		case update(flowId: String, state: CycleActivityState)
		case end(flowId: String)
	}

	/// The card for one flow: its cycle (one past those closed), progress from closed work, and who
	/// it is waiting on. Never a timer.
	public static func state(for loop: LoopSummary, needsYou: Bool) -> CycleActivityState {
		let total = loop.inProgressCount + loop.closedCount
		let progress = total == 0 ? 0 : Double(loop.closedCount) / Double(total)
		return CycleActivityState(
			flowName: loop.displayName, cycle: loop.closedCount + 1,
			stage: needsYou ? "" : loop.pill.label, progress: progress,
			summary: needsYou ? "Waiting on you." : "\(loop.inProgressCount) in progress.",
			phase: needsYou ? .needsYou : .running)
	}

	/// A flow gets a card only while it is running and the person opted in. A card whose flow is
	/// gone, paused or no longer followed ends; a card whose state moved updates.
	public static func plan(
		loops: [LoopSummary], needsYou: (LoopSummary) -> Bool, optedIn: Set<String>,
		active: [String: CycleActivityState]
	) -> [Action] {
		var actions: [Action] = []
		var wanted: Set<String> = []
		for loop in loops where optedIn.contains(loop.id) && loop.status.isLive {
			wanted.insert(loop.id)
			let next = state(for: loop, needsYou: needsYou(loop))
			if let current = active[loop.id] {
				if current != next { actions.append(.update(flowId: loop.id, state: next)) }
			} else {
				actions.append(.start(flowId: loop.id, state: next))
			}
		}
		for id in active.keys.sorted() where !wanted.contains(id) { actions.append(.end(flowId: id)) }
		return actions
	}
}

/// Runs the cycle activity from the foreground flow list: the app has no push path for it on this
/// server, so it follows what `LoopsStore` last loaded.
@MainActor
@Observable
public final class CycleActivityController {
	/// Set at launch on iOS; `nil` where Live Activities don't exist.
	@ObservationIgnored public static var shared: CycleActivityController?

	public private(set) var optedIn: Set<String>
	@ObservationIgnored private let storage: any CycleOptInStorage
	@ObservationIgnored private let host: any CycleActivityHosting
	@ObservationIgnored private var workspaceId: String?
	@ObservationIgnored private var active: [String: CycleActivityState] = [:]
	@ObservationIgnored private var lastLoops: [LoopSummary] = []
	@ObservationIgnored private var lastNeedsYou: Set<String> = []

	public init(host: any CycleActivityHosting, storage: any CycleOptInStorage = UserDefaultsCycleOptInStorage()) {
		self.host = host
		self.storage = storage
		self.optedIn = storage.load()
	}

	public func isOn(_ flowId: String) -> Bool { optedIn.contains(flowId) }

	public func setOn(_ on: Bool, flowId: String) {
		if on { optedIn.insert(flowId) } else { optedIn.remove(flowId) }
		storage.save(optedIn)
		apply(plan: CycleActivityPlanner.plan(loops: lastLoops, needsYou: { [lastNeedsYou] in lastNeedsYou.contains($0.id) }, optedIn: optedIn, active: active))
	}

	/// The signed-in workspace changed (nil: signed out): cards of the old one end.
	public func workspaceChanged(_ id: String?) async {
		guard id != workspaceId else { return }
		workspaceId = id
		let ending = active.keys.sorted()
		active = [:]
		lastLoops = []
		lastNeedsYou = []
		for flowId in ending { await host.end(flowId: flowId) }
	}

	/// The flow list changed. Cheap and idempotent.
	public func sync(loops: [LoopSummary], needsYou: (LoopSummary) -> Bool) {
		lastLoops = loops
		lastNeedsYou = Set(loops.filter(needsYou).map(\.id))
		apply(plan: CycleActivityPlanner.plan(loops: loops, needsYou: needsYou, optedIn: optedIn, active: active))
	}

	private func apply(plan: [CycleActivityPlanner.Action]) {
		guard let workspaceId else { return }
		for action in plan {
			switch action {
			case .start(let id, let state):
				active[id] = state
				host.start(flowId: id, workspaceId: workspaceId, state: state)
			case .update(let id, let state):
				active[id] = state
				Task { await host.update(flowId: id, state: state) }
			case .end(let id):
				active[id] = nil
				Task { await host.end(flowId: id) }
			}
		}
	}
}
