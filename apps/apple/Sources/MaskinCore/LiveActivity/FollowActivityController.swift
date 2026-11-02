import Foundation
import Observation

/// What the follow Live Activity needs from the platform. The app target implements it with
/// ActivityKit; tests use a recording fake.
@MainActor
public protocol FollowActivityHosting: AnyObject {
	func start(_ target: FollowTarget, state: FollowActivityState)
	func update(sessionId: String, state: FollowActivityState) async
	/// Ends the card for one session. `dismissAfter` 0 removes it at once; the finished card lingers.
	func end(sessionId: String, state: FollowActivityState?, dismissAfter: TimeInterval) async
	/// Sessions that already have a card on this device (the app was relaunched with one up).
	func activeSessionIds() -> Set<String>
	func endAll() async
}

/// Starts, updates and ends the opt-in follow cards. Follow is the only way a card starts; it is
/// kept in step by the same merged working-agents list the (now silent) Agents coordinator
/// builds, and ends when the followed session leaves that list.
@MainActor
@Observable
public final class FollowActivityController {
	/// Set at launch on iOS; `nil` where Live Activities don't exist.
	@ObservationIgnored public static var shared: FollowActivityController?

	/// Sessions being followed right now, for the Follow / Stop following toggle.
	public private(set) var followedSessionIds: Set<String> = []

	@ObservationIgnored private let host: any FollowActivityHosting
	@ObservationIgnored private var workspaceId: String?
	@ObservationIgnored private var shown: [String: FollowActivityState] = [:]

	public init(host: any FollowActivityHosting) { self.host = host }

	public func isFollowing(_ sessionId: String) -> Bool { followedSessionIds.contains(sessionId) }

	/// The person chose Follow on an agent's working banner. Needs a signed-in workspace.
	public func follow(_ agent: WorkingAgent) {
		guard let workspaceId, !followedSessionIds.contains(agent.sessionId) else { return }
		let state = FollowActivityState(following: agent)
		followedSessionIds.insert(agent.sessionId)
		shown[agent.sessionId] = state
		host.start(FollowTarget(agent, workspaceId: workspaceId), state: state)
	}

	/// Stop following (the button on the card, or the toggle on the banner). The card goes at once.
	public func stopFollowing(sessionId: String) async {
		followedSessionIds.remove(sessionId)
		let last = shown.removeValue(forKey: sessionId)
		await host.end(sessionId: sessionId, state: last, dismissAfter: 0)
	}

	/// The signed-in workspace changed (nil: signed out): cards of the old one end. On the first
	/// real workspace, cards the previous process left behind are adopted so Stop following works.
	public func workspaceChanged(_ id: String?) async {
		guard id != workspaceId else { return }
		let hadOne = workspaceId != nil
		workspaceId = id
		if hadOne || id == nil {
			followedSessionIds = []
			shown = [:]
			await host.endAll()
		}
		if id != nil { followedSessionIds.formUnion(host.activeSessionIds()) }
	}

	/// The merged list of working agents changed. Followed sessions that are still in it get their
	/// latest step; the ones that left it finished.
	public func workingChanged(_ agents: [WorkingAgent]) async {
		let bySession = Dictionary(agents.map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
		for sessionId in followedSessionIds.sorted() {
			if let agent = bySession[sessionId] {
				let next = FollowActivityState(following: agent)
				guard shown[sessionId] != next else { continue }
				shown[sessionId] = next
				await host.update(sessionId: sessionId, state: next)
			} else {
				followedSessionIds.remove(sessionId)
				var done = shown.removeValue(forKey: sessionId)
				done?.phase = .finished
				await host.end(
					sessionId: sessionId, state: done, dismissAfter: FollowActivityState.finishedLinger)
			}
		}
	}
}
