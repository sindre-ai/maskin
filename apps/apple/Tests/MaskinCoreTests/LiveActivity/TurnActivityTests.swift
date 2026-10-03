import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)

private func session(
	_ id: String, status: ChatAgentSession.Status, activity: String? = nil, actor: String = "a1"
) -> ChatAgentSession {
	ChatAgentSession(id: id, actorID: actor, status: status, currentActivity: activity, startedAt: t0)
}

@Suite("TurnActivityState")
struct TurnActivityStateTests {
	@Test func defaultsEmptyStepsPerStatus() {
		for (status, step) in [
			(TurnActivityStatus.running, "Working"), (.needsYou, "Needs you"), (.done, "Done"),
			(.failed, "Failed"),
		] {
			let s = TurnActivityState(sessionId: "s", agentName: "Forge", step: "  ", startedAt: t0, status: status)
			#expect(s.step == step)
		}
	}

	@Test func clampsLongFieldsToTheContractLimits() {
		let s = TurnActivityState(
			sessionId: "s", agentName: String(repeating: "n", count: 90),
			step: String(repeating: "x", count: 200), startedAt: t0, status: .running)
		#expect(s.agentName.count == TurnActivityState.maxAgentNameLength)
		#expect(s.step.count == TurnActivityState.maxStepLength)
	}

	@Test func blankAgentNameReadsAgent() {
		#expect(TurnActivityState(sessionId: "s", agentName: " ", startedAt: t0, status: .running).agentName == "Agent")
	}

	@Test func encodesTheBackendContractShape() throws {
		let s = TurnActivityState(sessionId: "s1", agentName: "Forge", step: "Reading", startedAt: t0, status: .needsYou)
		let json = try #require(
			JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any])
		#expect(Set(json.keys) == ["sessionId", "agentName", "step", "startedAt", "status"])
		// Default Date coding: seconds since 2001, NOT unix epoch.
		#expect(json["startedAt"] as? Double == 800_000_000)
		#expect(json["status"] as? String == "needsYou")
	}

	@Test func decodesAServerPushPayload() throws {
		let raw = Data(
			#"{"sessionId":"s1","agentName":"Forge","step":"Working","startedAt":800000000.0,"status":"running"}"#.utf8)
		let s = try JSONDecoder().decode(TurnActivityState.self, from: raw)
		#expect(s.startedAt == t0)
		#expect(s.status == .running)
	}
}

@Suite("LiveTurn mapping")
struct LiveTurnTests {
	private func map(_ sessions: [ChatAgentSession]) -> [LiveTurn] {
		LiveTurn.turns(
			from: sessions, workspaceId: "ws", conversationId: "c1",
			agentName: { $0 == "a1" ? "Forge" : nil }, now: t0)
	}

	@Test func mapsSessionStatuses() {
		let turns = map([
			session("1", status: .running, activity: "Reading files"), session("2", status: .starting),
			session("3", status: .paused), session("4", status: .completed),
			session("5", status: .timeout), session("6", status: .other("weird")),
		])
		#expect(turns.map(\.state.status) == [.running, .running, .needsYou, .done, .failed])
		#expect(turns.first?.state.step == "Reading files")
		#expect(turns.first?.state.agentName == "Forge")
	}

	@Test func unresolvedAgentNeverShowsAnId() {
		let turn = map([session("1", status: .running, actor: "9f1c-uuid")])[0]
		#expect(turn.state.agentName == "Agent")
	}

	@Test func identityLinksToTheThreadThroughDeepLink() {
		let turn = map([session("1", status: .running)])[0]
		#expect(DeepLink(url: turn.identity.openURL) == .chat(workspaceId: "ws", id: "c1"))
		let noThread = TurnActivityIdentity(sessionId: "s", workspaceId: "ws", conversationId: nil)
		#expect(DeepLink(url: noThread.openURL) == .notifications(workspaceId: "ws"))
	}
}

@MainActor
private final class FakeHost: TurnActivityHosting {
	var active: Set<String> = []
	var log: [String] = []
	func activeSessionIds() -> Set<String> { active }
	func start(_ identity: TurnActivityIdentity, state: TurnActivityState) async {
		active.insert(identity.sessionId)
		log.append("start:\(identity.sessionId):\(state.status.rawValue)")
	}
	func update(sessionId: String, state: TurnActivityState) async {
		log.append("update:\(sessionId):\(state.status.rawValue)")
	}
	func end(sessionId: String, state: TurnActivityState, dismissAfter: TimeInterval) async {
		active.remove(sessionId)
		log.append("end:\(sessionId):\(state.status.rawValue):\(Int(dismissAfter))")
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
	func unregister(tokenId: String) async throws { calls.append("unregister:\(tokenId)") }
}

@MainActor
@Suite("TurnActivityCoordinator")
struct TurnActivityCoordinatorTests {
	private func turn(_ id: String, _ status: TurnActivityStatus, step: String? = nil) -> LiveTurn {
		LiveTurn(
			identity: TurnActivityIdentity(sessionId: id, workspaceId: "ws", conversationId: "c1"),
			state: TurnActivityState(sessionId: id, agentName: "Forge", step: step, startedAt: t0, status: status))
	}

	@Test func startsUpdatesThenEnds() async {
		let host = FakeHost()
		let coordinator = TurnActivityCoordinator(host: host, tokens: FakeTokens())
		await coordinator.reconcile([turn("s1", .running)])
		await coordinator.reconcile([turn("s1", .running)])  // unchanged: no update
		await coordinator.reconcile([turn("s1", .running, step: "Writing")])
		await coordinator.reconcile([turn("s1", .done)])
		await coordinator.reconcile([turn("s1", .done)])  // already ended
		#expect(host.log == ["start:s1:running", "update:s1:running", "end:s1:done:120"])
	}

	@Test func failedLingersLongerThanDone() async {
		let host = FakeHost()
		let coordinator = TurnActivityCoordinator(host: host, tokens: FakeTokens())
		await coordinator.reconcile([turn("s1", .running)])
		await coordinator.reconcile([turn("s1", .failed)])
		#expect(host.log.last == "end:s1:failed:600")
	}

	@Test func adoptsAnActivityTheServerAlreadyStarted() async {
		let host = FakeHost()
		host.active = ["s1"]
		let coordinator = TurnActivityCoordinator(host: host, tokens: FakeTokens())
		await coordinator.reconcile([turn("s1", .running)])
		#expect(host.log == ["update:s1:running"])
	}

	@Test func neverStartsAnActivityForAnAlreadyFinishedTurn() async {
		let host = FakeHost()
		let coordinator = TurnActivityCoordinator(host: host, tokens: FakeTokens())
		await coordinator.reconcile([turn("old", .done), turn("older", .failed)])
		#expect(host.log.isEmpty)
	}

	@Test func tokensWaitForTheDeviceThenRegister() async {
		let tokens = FakeTokens()
		let coordinator = TurnActivityCoordinator(host: FakeHost(), tokens: tokens)
		await coordinator.pushToStartTokenChanged("aa")
		await coordinator.updateTokenChanged(sessionId: "s1", token: "bb")
		#expect(await tokens.calls.isEmpty)
		await coordinator.deviceChanged("dev-1")
		let calls = await tokens.calls
		#expect(calls.contains("register:push_to_start:dev-1:-:aa"))
		#expect(calls.contains("register:update:dev-1:s1:bb"))
	}

	@Test func identicalTokensAreNotResent() async {
		let tokens = FakeTokens()
		let coordinator = TurnActivityCoordinator(host: FakeHost(), tokens: tokens)
		await coordinator.deviceChanged("dev-1")
		await coordinator.pushToStartTokenChanged("aa")
		await coordinator.pushToStartTokenChanged("aa")
		await coordinator.pushToStartTokenChanged("cc")
		#expect(await tokens.calls.count == 2)
	}

	@Test func aFailedRegistrationRetriesOnTheNextChange() async {
		let tokens = FakeTokens()
		await tokens.setFailing(true)
		let coordinator = TurnActivityCoordinator(host: FakeHost(), tokens: tokens)
		await coordinator.deviceChanged("dev-1")
		await coordinator.pushToStartTokenChanged("aa")
		#expect(await tokens.calls.isEmpty)
		await tokens.setFailing(false)
		await coordinator.deviceChanged("dev-1")
		#expect(await tokens.calls == ["register:push_to_start:dev-1:-:aa"])
	}

	@Test func endingDeletesTheUpdateToken() async {
		let tokens = FakeTokens()
		let coordinator = TurnActivityCoordinator(host: FakeHost(), tokens: tokens)
		await coordinator.deviceChanged("dev-1")
		await coordinator.reconcile([turn("s1", .running)])
		await coordinator.updateTokenChanged(sessionId: "s1", token: "bb")
		await coordinator.reconcile([turn("s1", .done)])
		#expect(await tokens.calls.last == "unregister:tok-1")
	}

	@Test func tokenRequestBodyMatchesTheContract() throws {
		let body = APILiveActivityTokens.body(kind: .update, deviceId: "d", sessionId: "s", token: "ab")
		let json = try #require(
			JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
		#expect(json["kind"] as? String == "update")
		#expect(json["device_id"] as? String == "d")
		#expect(json["session_id"] as? String == "s")
		let start = APILiveActivityTokens.body(kind: .pushToStart, deviceId: "d", sessionId: nil, token: "ab")
		let startJSON = try #require(
			JSONSerialization.jsonObject(with: JSONEncoder().encode(start)) as? [String: Any])
		#expect(startJSON["session_id"] == nil)
	}
}
