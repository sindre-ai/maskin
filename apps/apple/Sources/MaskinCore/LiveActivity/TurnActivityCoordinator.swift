import Foundation
import Observation

/// The ActivityKit side, behind a protocol so the coordinator tests without a device.
@MainActor
public protocol TurnActivityHosting: AnyObject {
	/// Sessions that already have an activity on this device (a push-to-start may have made one).
	func activeSessionIds() -> Set<String>
	func start(_ identity: TurnActivityIdentity, state: TurnActivityState) async
	func update(sessionId: String, state: TurnActivityState) async
	/// `dismissAfter` is how long the finished card lingers on the Lock Screen.
	func end(sessionId: String, state: TurnActivityState, dismissAfter: TimeInterval) async
	/// Ends every activity at once, with no lingering card (sign-out).
	func endAll() async
}

public enum LiveActivityTokenKind: String, Codable, Sendable {
	case pushToStart = "push_to_start"
	case update
}

/// `POST /api/live-activities/tokens` and `DELETE /api/live-activities/tokens/{id}`.
public protocol LiveActivityTokenRegistering: Sendable {
	func register(kind: LiveActivityTokenKind, deviceId: String, sessionId: String?, token: String)
		async throws -> String
	/// `credentials` overrides the live session's, for the sign-out teardown where the live
	/// session is already gone.
	func unregister(tokenId: String, credentials: APILiveActivityTokens.Credentials?) async throws
}

/// Starts, updates and ends the Live Activity for agent turns while the app is in the foreground
/// (the backend's APNs pushes cover the background), and keeps the activity tokens registered
/// with the backend so those pushes can reach it.
///
/// Token registration needs the server's device id (from `POST /api/devices`); tokens that
/// arrive before it are held and flushed from `deviceChanged(_:)`.
@MainActor
public final class TurnActivityCoordinator {
	/// The app's coordinator, set at launch on iOS. Screens feed it; `nil` where Live Activities don't exist.
	public static var shared: TurnActivityCoordinator?

	public static let doneLinger: TimeInterval = 120
	public static let failedLinger: TimeInterval = 600

	private let host: any TurnActivityHosting
	private let tokens: any LiveActivityTokenRegistering
	private var deviceId: String?
	private var lastState: [String: TurnActivityState] = [:]
	private var ended: Set<String> = []
	private var pushToStartToken: String?
	private var updateTokens: [String: String] = [:]
	/// Server ids of registered tokens, keyed `"start"` or the session id.
	private var registered: [String: (id: String, token: String, device: String)] = [:]

	public init(host: any TurnActivityHosting, tokens: any LiveActivityTokenRegistering) {
		self.host = host
		self.tokens = tokens
	}

	// MARK: Turns

	/// Call with the turns of one conversation whenever its sessions refresh.
	public func reconcile(_ turns: [LiveTurn]) async {
		let existing = host.activeSessionIds()
		for turn in turns {
			let id = turn.identity.sessionId
			let state = turn.state
			guard !ended.contains(id) else { continue }
			let tracked = existing.contains(id) || lastState[id] != nil
			if state.status.isTerminal {
				guard tracked else { continue }
				lastState[id] = nil
				ended.insert(id)
				await host.end(
					sessionId: id, state: state,
					dismissAfter: state.status == .failed ? Self.failedLinger : Self.doneLinger)
				await dropUpdateToken(for: id)
			} else if tracked {
				guard lastState[id] != state else { continue }
				lastState[id] = state
				await host.update(sessionId: id, state: state)
			} else {
				lastState[id] = state
				await host.start(turn.identity, state: state)
			}
		}
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

	public func updateTokenChanged(sessionId: String, token: String) async {
		updateTokens[sessionId] = token
		await flush()
	}

	/// The activity ended on the device (by us, a push, the user or the system).
	public func activityEnded(sessionId: String) async {
		ended.insert(sessionId)
		lastState[sessionId] = nil
		await dropUpdateToken(for: sessionId)
	}

	/// The account signed out: end every card and delete every registered update token so pushes
	/// for this account stop reaching the device. `credentials` are the ending session's, because
	/// the live session is already cleared by the time the DELETEs go out. The push-to-start token
	/// is kept (it belongs to the device) and is re-registered under the next account's session.
	public func signedOut(credentials: APILiveActivityTokens.Credentials?) async {
		await host.endAll()
		let entries = registered
		registered = [:]
		updateTokens = [:]
		lastState = [:]
		ended = []
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
		for (session, token) in updateTokens where needsRegistration(session, token: token, device: device) {
			if let id = try? await tokens.register(
				kind: .update, deviceId: device, sessionId: session, token: token)
			{
				registered[session] = (id, token, device)
			}
		}
	}

	private func dropUpdateToken(for sessionId: String) async {
		updateTokens[sessionId] = nil
		if let entry = registered.removeValue(forKey: sessionId) {
			try? await tokens.unregister(tokenId: entry.id, credentials: nil)
		}
	}
}
