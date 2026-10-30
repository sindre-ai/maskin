import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)

/// A clock the coordinator reads and sleeps against, so throttling is deterministic.
@MainActor
private final class Clock {
	var now = t0
	var slept: [TimeInterval] = []
	func advance(_ s: TimeInterval) { now = now.addingTimeInterval(s) }
}

@MainActor
private final class FakeHost: AgentsActivityHosting {
	var active: AgentsActivityIdentity?
	var log: [String] = []
	var states: [AgentsActivityState] = []

	func activeIdentity() -> AgentsActivityIdentity? { active }
	func start(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async {
		active = identity
		states.append(state)
		log.append("start:\(state.count)")
	}
	func update(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async {
		states.append(state)
		log.append("update:\(state.count)")
	}
	func end(_ identity: AgentsActivityIdentity, state: AgentsActivityState, dismissAfter: TimeInterval) async {
		active = nil
		states.append(state)
		log.append("end:\(Int(dismissAfter))")
	}
	func endAll() async {
		active = nil
		log.append("endAll")
	}
}

private actor FakeTokens: LiveActivityTokenRegistering {
	var calls: [String] = []
	var failing = false
	func setFailing(_ v: Bool) { failing = v }
	func register(kind: LiveActivityTokenKind, deviceId: String, sessionId: String?, token: String)
		async throws -> String
	{
		if failing { throw URLError(.notConnectedToInternet) }
		calls.append("register:\(kind.rawValue):\(deviceId):\(sessionId ?? "-"):\(token)")
		return "tok-\(calls.count)"
	}
	func unregister(tokenId: String, credentials: APILiveActivityTokens.Credentials?) async throws {
		calls.append("unregister:\(tokenId):\(credentials?.apiKey ?? "live")")
	}
}

private func agent(_ id: String, session: String? = nil, doing: String = "working") -> WorkingAgent {
	WorkingAgent(id: id, sessionId: session ?? "s-\(id)", name: id.capitalized, doing: doing, startedAt: t0)
}

private func turn(_ session: String, actor: String, _ status: LiveTurn.Status, step: String? = nil, conversation: String = "c1", ws: String = "ws") -> LiveTurn {
	LiveTurn(
		sessionId: session, workspaceId: ws, conversationId: conversation, actorId: actor,
		agentName: actor.capitalized, step: step, startedAt: t0, status: status)
}

@MainActor
@Suite("AgentsActivityCoordinator")
struct AgentsActivityCoordinatorTests {
	private func make(interval: TimeInterval = 1, tokens: FakeTokens = FakeTokens())
		-> (AgentsActivityCoordinator, FakeHost, Clock)
	{
		let host = FakeHost()
		let clock = Clock()
		let coordinator = AgentsActivityCoordinator(
			host: host, tokens: tokens, minUpdateInterval: interval, now: { clock.now },
			sleep: { s in
				await MainActor.run {
					clock.slept.append(s)
					clock.advance(s)
				}
			})
		return (coordinator, host, clock)
	}

	@Test func zeroToOneToThreeToZero() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([])
		#expect(host.log == ["endAll"])  // nothing to show: no card
		await coordinator.feedChanged([agent("a")])
		clock.advance(5)
		await coordinator.feedChanged([agent("a"), agent("b"), agent("c")])
		clock.advance(5)
		await coordinator.feedChanged([])
		#expect(host.log == ["endAll", "start:1", "update:3", "end:60"])
		#expect(host.states.last?.isEmpty == true)
		#expect(host.states.last?.headline(now: clock.now) == "Agents finished")
	}

	@Test func anUnchangedFeedSendsNothing() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([agent("a")])
		clock.advance(5)
		await coordinator.feedChanged([agent("a")])
		#expect(host.log == ["endAll", "start:1"])
	}

	@Test func updatesAreThrottledAndTheLastChangeAlwaysLands() async {
		let (coordinator, host, clock) = make(interval: 2)
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([agent("a")])
		clock.advance(0.5)
		await coordinator.feedChanged([agent("a"), agent("b")])  // too soon: queued
		await coordinator.feedChanged([agent("a"), agent("b"), agent("c")])  // coalesced into the same wait
		#expect(host.log == ["endAll", "start:1"])
		#expect(await eventually { host.log.count == 3 })
		#expect(host.log == ["endAll", "start:1", "update:3"])
		#expect(clock.slept == [1.5])
	}

	@Test func aChangeAfterTheIntervalGoesStraightOut() async {
		let (coordinator, host, clock) = make(interval: 2)
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([agent("a")])
		clock.advance(2)
		await coordinator.feedChanged([agent("a"), agent("b")])
		#expect(host.log == ["endAll", "start:1", "update:2"])
		#expect(clock.slept.isEmpty)
	}

	@Test func theOpenThreadAddsItsRunningTurnAndDropsItWhenTheReplyLands() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([agent("loop")])
		clock.advance(5)
		await coordinator.reconcile([turn("s-chat", actor: "forge", .running, step: "Reading")])
		#expect(host.log.last == "update:2")
		#expect(host.states.last?.agents.map(\.id).sorted() == ["forge", "loop"])
		clock.advance(5)
		await coordinator.reconcile([turn("s-chat", actor: "forge", .done)])
		#expect(host.log.last == "update:1")
		#expect(host.states.last?.agents.map(\.id) == ["loop"])
	}

	@Test func anEmptyThreadReportClearsItsOverlay() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.reconcile([turn("s1", actor: "forge", .running)])
		#expect(host.log == ["endAll", "start:1"])
		clock.advance(5)
		await coordinator.reconcile([], conversationId: "c1")
		#expect(host.log.last == "end:60")
	}

	@Test func aTurnThatNeedsYouIsNeverOnTheCard() async {
		let (coordinator, host, _) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.reconcile([turn("s1", actor: "forge", .needsYou)])
		#expect(host.log == ["endAll"])
	}

	@Test func theThreadKnowsASessionFinishedBeforeTheFeedDoes() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([agent("forge", session: "s1"), agent("other")])
		clock.advance(5)
		await coordinator.reconcile([turn("s1", actor: "forge", .done)])
		#expect(host.states.last?.agents.map(\.id) == ["other"])
	}

	@Test func aStaleThreadOverlayExpires() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.reconcile([turn("s1", actor: "forge", .running)])
		#expect(host.log == ["endAll", "start:1"])
		clock.advance(AgentsActivityCoordinator.overlayTTL + 1)
		await coordinator.feedChanged([])
		#expect(host.log.last == "end:60")
	}

	@Test func turnsFromAnotherWorkspaceAreIgnored() async {
		let (coordinator, host, _) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.reconcile([turn("s1", actor: "forge", .running, ws: "other")])
		#expect(host.log == ["endAll"])
	}

	@Test func adoptsAnActivityTheServerAlreadyStarted() async {
		let (coordinator, host, _) = make()
		host.active = AgentsActivityIdentity(workspaceId: "ws")
		await coordinator.workspaceChanged("ws")
		host.active = AgentsActivityIdentity(workspaceId: "ws")  // workspaceChanged ends everything first
		await coordinator.feedChanged([agent("a")])
		#expect(host.log == ["endAll", "update:1"])
	}

	@Test func aCardTheUserDismissedOnlyComesBackForANewAgent() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([agent("a")])
		host.active = nil
		await coordinator.activityEnded()
		clock.advance(5)
		await coordinator.feedChanged([agent("a")])
		#expect(host.log == ["endAll", "start:1"])
		await coordinator.feedChanged([agent("a"), agent("b")])
		#expect(host.log == ["endAll", "start:1", "start:2"])
	}

	@Test func switchingWorkspaceEndsTheOldCardAndStartsFresh() async {
		let (coordinator, host, clock) = make()
		await coordinator.workspaceChanged("ws")
		await coordinator.feedChanged([agent("a")])
		clock.advance(5)
		await coordinator.workspaceChanged("ws2")
		#expect(host.log == ["endAll", "start:1", "endAll"])
		#expect(coordinator.currentState.isEmpty)
		await coordinator.feedChanged([agent("z")])
		#expect(host.log.last == "start:1")
	}

	@Test func nothingHappensWithoutAWorkspace() async {
		let (coordinator, host, _) = make()
		await coordinator.feedChanged([agent("a")])
		await coordinator.reconcile([turn("s1", actor: "forge", .running)])
		#expect(host.log.isEmpty)
	}

	// MARK: Tokens

	@Test func tokensWaitForTheDeviceThenRegisterWithoutASessionId() async {
		let tokens = FakeTokens()
		let (coordinator, _, _) = make(tokens: tokens)
		await coordinator.pushToStartTokenChanged("aa")
		await coordinator.updateTokenChanged("bb")
		#expect(await tokens.calls.isEmpty)
		await coordinator.deviceChanged("dev-1")
		let calls = await tokens.calls
		#expect(calls.contains("register:push_to_start:dev-1:-:aa"))
		#expect(calls.contains("register:update:dev-1:-:bb"))
	}

	@Test func aNewUpdateTokenReplacesTheOldRegistration() async {
		let tokens = FakeTokens()
		let (coordinator, _, _) = make(tokens: tokens)
		await coordinator.deviceChanged("dev-1")
		await coordinator.updateTokenChanged("bb")
		await coordinator.updateTokenChanged("bb")
		await coordinator.updateTokenChanged("cc")
		#expect(await tokens.calls == ["register:update:dev-1:-:bb", "register:update:dev-1:-:cc", "unregister:tok-1:live"])
	}

	@Test func aFailedRegistrationRetriesOnTheNextChange() async {
		let tokens = FakeTokens()
		await tokens.setFailing(true)
		let (coordinator, _, _) = make(tokens: tokens)
		await coordinator.deviceChanged("dev-1")
		await coordinator.pushToStartTokenChanged("aa")
		#expect(await tokens.calls.isEmpty)
		await tokens.setFailing(false)
		await coordinator.deviceChanged("dev-1")
		#expect(await tokens.calls == ["register:push_to_start:dev-1:-:aa"])
	}

	@Test func signOutEndsTheCardAndDeletesEveryRegisteredToken() async {
		let tokens = FakeTokens()
		let (coordinator, host, _) = make(tokens: tokens)
		await coordinator.workspaceChanged("ws")
		await coordinator.deviceChanged("dev-1")
		await coordinator.pushToStartTokenChanged("aa")
		await coordinator.feedChanged([agent("a")])
		await coordinator.updateTokenChanged("b1")
		let creds = APILiveActivityTokens.Credentials(apiKey: "ank_old", workspaceId: "ws")
		await coordinator.signedOut(credentials: creds)
		#expect(host.log.last == "endAll")
		#expect(host.active == nil)
		let unregisters = await tokens.calls.filter { $0.hasPrefix("unregister:") }
		#expect(unregisters.count == 2)
		#expect(unregisters.allSatisfy { $0.hasSuffix(":ank_old") })
	}

	@Test func afterSignOutNothingStaleIsReRegisteredOrShown() async {
		let tokens = FakeTokens()
		let (coordinator, host, _) = make(tokens: tokens)
		await coordinator.workspaceChanged("ws")
		await coordinator.deviceChanged("dev-1")
		await coordinator.feedChanged([agent("a")])
		await coordinator.updateTokenChanged("b1")
		await coordinator.signedOut(credentials: nil)
		let before = await tokens.calls.count
		await coordinator.deviceChanged("dev-1")  // would re-flush a leftover update token
		#expect(await tokens.calls.count == before)
		await coordinator.feedChanged([agent("a")])  // no workspace: nothing shows
		#expect(host.log.last == "endAll")
	}

	@Test func tokenRequestBodyMatchesTheContract() throws {
		let body = APILiveActivityTokens.body(kind: .update, deviceId: "d", sessionId: nil, token: "ab")
		let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
		#expect(json["kind"] as? String == "update")
		#expect(json["device_id"] as? String == "d")
		#expect(json["session_id"] == nil)
		#expect(json["token"] as? String == "ab")
	}
}
