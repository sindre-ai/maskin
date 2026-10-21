import Foundation
import Observation

/// The ActivityKit side, behind a protocol so the coordinator tests without a device. There is
/// at most ONE activity on a device at a time (the aggregate "Agents working" card).
@MainActor
public protocol AgentsActivityHosting: AnyObject {
	/// The identity of the activity already on this device, if any (a push-to-start may have made
	/// one while the app was not running).
	func activeIdentity() -> AgentsActivityIdentity?
	func start(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async
	func update(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async
	/// `dismissAfter` is how long the finished card lingers on the Lock Screen.
	func end(_ identity: AgentsActivityIdentity, state: AgentsActivityState, dismissAfter: TimeInterval) async
	/// Ends every activity at once, with no lingering card (sign-out, workspace switch).
	func endAll() async
	/// Every activity of ours on the device, active or stale (for the sweep).
	func cards() -> [AgentsActivityCard]
	/// Ends one activity with no lingering.
	func endNow(cardID: String) async
}

extension AgentsActivityHosting {
	public func cards() -> [AgentsActivityCard] { [] }
	public func endNow(cardID: String) async {}
}

public enum LiveActivityTokenKind: String, Codable, Sendable {
	case pushToStart = "push_to_start"
	case update
}

/// `POST /api/live-activities/tokens` and `DELETE /api/live-activities/tokens/{id}`.
public protocol LiveActivityTokenRegistering: Sendable {
	/// `sessionId` is a legacy field of the per-session design; the aggregate activity registers
	/// its update token with `nil` (one token per device, not per session).
	func register(kind: LiveActivityTokenKind, deviceId: String, sessionId: String?, token: String)
		async throws -> String
	/// `credentials` overrides the live session's, for the sign-out teardown where the live
	/// session is already gone.
	func unregister(tokenId: String, credentials: APILiveActivityTokens.Credentials?) async throws
}

/// Keeps the one "Agents working" Live Activity in step with the agents doing time-bound work
/// in the signed-in workspace while the app runs (the backend's APNs pushes cover the
/// background), and keeps the activity tokens registered with the backend so those pushes can
/// reach it.
///
/// Two inputs are folded into one state:
/// - `feedChanged(_:)` — the workspace-wide session list (`WorkingAgentsFeed`): every
///   non-interactive running session.
/// - `reconcile(_:)` — the open conversation's turns (`ChatsScreen`): chat sessions stay
///   `running` between turns, so only the thread knows when its agent is actually working.
///
/// The activity starts when the first agent begins, updates on every change (throttled to one
/// update per `minUpdateInterval`, the last change always lands), and ends when the last agent
/// finishes. Token registration needs the server's device id (`POST /api/devices`); tokens that
/// arrive before it are held and flushed from `deviceChanged(_:)`.
@MainActor
public final class AgentsActivityCoordinator {
	/// The app's coordinator, set at launch on iOS. Screens feed it; `nil` where Live Activities don't exist.
	public static var shared: AgentsActivityCoordinator?

	/// How long the "Agents finished" card stays on the Lock Screen.
	public static let finishedLinger: TimeInterval = 60
	/// A thread's overlay that has not been refreshed for this long is dropped: the thread was
	/// closed and nothing will ever report its turn finished.
	public static let overlayTTL: TimeInterval = 10 * 60

	public typealias Sleep = @Sendable (TimeInterval) async -> Void

	private let host: any AgentsActivityHosting
	private let tokens: any LiveActivityTokenRegistering
	private let now: () -> Date
	private let sleep: Sleep
	private let minUpdateInterval: TimeInterval

	private var identity: AgentsActivityIdentity?
	private var feedAgents: [WorkingAgent] = []
	private struct Overlay {
		var running: [WorkingAgent]
		var finishedSessions: Set<String>
		var at: Date
	}
	private var overlays: [String: Overlay] = [:]
	/// What the device currently shows (nil: no activity of ours).
	private var shown: AgentsActivityState?
	private var lastUpdateAt: Date?
	private var pendingUpdate: Task<Void, Never>?
	/// Agents on the card when the user dismissed it; the card does not come back for them.
	private var dismissedFor: Set<String>?

	/// True once the workspace's session list has arrived: before that, "no agents" is unknown.
	private var feedLoaded = false

	private var deviceId: String?
	private var pushToStartToken: String?
	private var updateToken: String?
	/// Server ids of registered tokens, keyed `"start"` or `"update"`.
	private var registered: [String: (id: String, token: String, device: String)] = [:]

	public init(
		host: any AgentsActivityHosting, tokens: any LiveActivityTokenRegistering,
		minUpdateInterval: TimeInterval = 1,
		now: @escaping () -> Date = Date.init,
		sleep: @escaping Sleep = { try? await Task.sleep(for: .seconds($0)) }
	) {
		self.host = host
		self.tokens = tokens
		self.minUpdateInterval = minUpdateInterval
		self.now = now
		self.sleep = sleep
	}

	/// The state the card would show right now, for tests and the host's adoption path.
	public var currentState: AgentsActivityState { state() }

	// MARK: Inputs

	/// The signed-in workspace changed (or went away). A card from another workspace is ended at
	/// once: its agents, links and Pause targets belong to the old one.
	public func workspaceChanged(_ workspaceId: String?) async {
		let next = workspaceId.map(AgentsActivityIdentity.init(workspaceId:))
		guard next != identity else { return }
		identity = next
		feedAgents = []
		feedLoaded = false
		overlays = [:]
		dismissedFor = nil
		pendingUpdate?.cancel()
		pendingUpdate = nil
		shown = nil
		lastUpdateAt = nil
		await host.endAll()
	}

	/// The workspace-wide session list refreshed.
	public func feedChanged(_ agents: [WorkingAgent]) async {
		feedAgents = agents
		feedLoaded = true
		await apply()
	}

	/// Ends cards that cannot be showing live work: another workspace's, orphans nobody ended
	/// (a push-to-start whose end push never came), and duplicates. Safe to call often.
	public func sweep() async {
		let plan = AgentsActivitySweep.plan(
			cards: host.cards(), workspaceId: identity?.workspaceId, feedLoaded: feedLoaded,
			hasWorkingAgents: !state().isEmpty)
		guard !plan.ends.isEmpty else { return }
		for end in plan.ends { await host.endNow(cardID: end.cardID) }
		if plan.ends.contains(where: { $0.reason != .duplicate }), host.cards().isEmpty {
			pendingUpdate?.cancel()
			pendingUpdate = nil
			shown = nil
			lastUpdateAt = nil
		}
	}

	/// Call with the turns of one conversation whenever its sessions refresh.
	public func reconcile(_ turns: [LiveTurn]) async {
		guard let conversationId = turns.first?.conversationId else { return }
		if let identity, turns.contains(where: { $0.workspaceId != identity.workspaceId }) { return }
		overlays[conversationId] = Overlay(
			running: turns.compactMap(\.workingAgent),
			finishedSessions: Set(turns.filter { $0.status != .running }.map(\.sessionId)),
			at: now())
		await apply()
	}

	/// The activity ended on the device (by us, a push, the user or the system).
	public func activityEnded() async {
		pendingUpdate?.cancel()
		pendingUpdate = nil
		if let shown, !shown.isEmpty { dismissedFor = Set(state().agents.map(\.id)) }
		shown = nil
		lastUpdateAt = nil
	}

	// MARK: Folding

	private func state() -> AgentsActivityState {
		let now = now()
		overlays = overlays.filter { now.timeIntervalSince($0.value.at) < Self.overlayTTL }
		let finished = overlays.values.reduce(into: Set<String>()) { $0.formUnion($1.finishedSessions) }
		var byAgent: [String: WorkingAgent] = [:]
		for agent in feedAgents where !finished.contains(agent.sessionId) { byAgent[agent.id] = agent }
		for overlay in overlays.values {
			for agent in overlay.running { byAgent[agent.id] = agent }
		}
		return AgentsActivityState(agents: Array(byAgent.values), now: now)
	}

	private func apply() async {
		guard let identity else { return }
		let next = state()
		let onDevice = shown != nil || host.activeIdentity() == identity

		if next.isEmpty {
			guard onDevice else { return }
			pendingUpdate?.cancel()
			pendingUpdate = nil
			shown = nil
			lastUpdateAt = nil
			dismissedFor = nil
			await host.end(identity, state: next, dismissAfter: Self.finishedLinger)
			return
		}

		if !onDevice {
			// The user swiped the card away: it only comes back once a new agent starts.
			if let dismissedFor, Set(next.agents.map(\.id)).isSubset(of: dismissedFor) { return }
			dismissedFor = nil
			shown = next
			lastUpdateAt = now()
			await host.start(identity, state: next)
			return
		}

		guard next != shown else { return }
		let elapsed = now().timeIntervalSince(lastUpdateAt ?? .distantPast)
		if elapsed >= minUpdateInterval {
			pendingUpdate?.cancel()
			pendingUpdate = nil
			await send(next, to: identity)
		} else if pendingUpdate == nil {
			let wait = minUpdateInterval - elapsed
			pendingUpdate = Task { [weak self, sleep] in
				await sleep(wait)
				guard !Task.isCancelled, let self else { return }
				self.pendingUpdate = nil
				guard let identity = self.identity, self.shown != nil else { return }
				let latest = self.state()
				if latest.isEmpty {
					await self.apply()
				} else if latest != self.shown {
					await self.send(latest, to: identity)
				}
			}
		}
	}

	private func send(_ state: AgentsActivityState, to identity: AgentsActivityIdentity) async {
		shown = state
		lastUpdateAt = now()
		await host.update(identity, state: state)
	}

	// MARK: Tokens

	public func deviceChanged(_ id: String?) async {
		deviceId = id
		await flush()
	}

	public func pushToStartTokenChanged(_ token: String) async {
		pushToStartToken = token
		await flush()
	}

	/// The one activity's update token (a new one arrives every time an activity starts).
	public func updateTokenChanged(_ token: String) async {
		updateToken = token
		await flush()
	}

	/// The account signed out: end the card and delete every registered token so pushes for this
	/// account stop reaching the device. `credentials` are the ending session's, because the
	/// live session is already cleared by the time the DELETEs go out. The push-to-start token
	/// is kept (it belongs to the device) and is re-registered under the next account's session.
	public func signedOut(credentials: APILiveActivityTokens.Credentials?) async {
		pendingUpdate?.cancel()
		pendingUpdate = nil
		await host.endAll()
		let entries = registered
		registered = [:]
		updateToken = nil
		identity = nil
		feedAgents = []
		overlays = [:]
		shown = nil
		lastUpdateAt = nil
		dismissedFor = nil
		for entry in entries.values {
			try? await tokens.unregister(tokenId: entry.id, credentials: credentials)
		}
	}

	private func needsRegistration(_ key: String, token: String, device: String) -> Bool {
		guard let entry = registered[key] else { return true }
		return entry.token != token || entry.device != device
	}

	private func flush() async {
		guard let device = deviceId else { return }
		if let token = pushToStartToken, needsRegistration("start", token: token, device: device) {
			if let id = try? await tokens.register(
				kind: .pushToStart, deviceId: device, sessionId: nil, token: token)
			{
				registered["start"] = (id, token, device)
			}
		}
		if let token = updateToken, needsRegistration("update", token: token, device: device) {
			let previous = registered["update"]
			if let id = try? await tokens.register(kind: .update, deviceId: device, sessionId: nil, token: token) {
				registered["update"] = (id, token, device)
				if let previous, previous.id != id {
					try? await tokens.unregister(tokenId: previous.id, credentials: nil)
				}
			}
		}
	}
}

/// The per-session coordinator this one replaced; `ChatsScreen` still refers to it by this name.
public typealias TurnActivityCoordinator = AgentsActivityCoordinator
