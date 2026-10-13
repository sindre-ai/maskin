import Foundation
import Testing

@testable import MaskinCore

private actor FakePausing: SessionPausing {
	var paused: [String] = []
	var refusing: Set<String> = []
	func refuse(_ ids: Set<String>) { refusing = ids }
	func pause(sessionID: String) async throws {
		if refusing.contains(sessionID) { throw AgentsError("Cannot pause session") }
		paused.append(sessionID)
	}
}

@Suite("SessionPauser")
struct SessionPauserTests {
	private func pauser(signedInWorkspace: String?, api: FakePausing) throws -> SessionPauser {
		let store = InMemorySecretStore()
		let stored = StoredSession(apiKey: "ank_x", actorId: "me", name: "Me", workspaceId: signedInWorkspace)
		try store.write(JSONEncoder().encode(stored))
		return SessionPauser(secrets: store) { _, _ in api }
	}

	@Test func pausesEveryAgentOfTheSignedInWorkspace() async throws {
		let api = FakePausing()
		let paused = await (try pauser(signedInWorkspace: "ws", api: api)).pause(sessionIds: ["s2", "s1", "s1"], workspaceId: "ws")
		#expect(paused == ["s1", "s2"])
		#expect(await api.paused.sorted() == ["s1", "s2"])
	}

	@Test func oneRefusalDoesNotStopTheOthers() async throws {
		let api = FakePausing()
		await api.refuse(["s2"])
		let paused = await (try pauser(signedInWorkspace: "ws", api: api)).pause(sessionIds: ["s1", "s2", "s3"], workspaceId: "ws")
		#expect(paused == ["s1", "s3"])
	}

	@Test func refusesACardFromAnotherWorkspace() async throws {
		let api = FakePausing()
		let paused = await (try pauser(signedInWorkspace: "other", api: api)).pause(sessionIds: ["s1"], workspaceId: "ws")
		#expect(paused.isEmpty)
		#expect(await api.paused.isEmpty)
	}

	@Test func dropsIdsThatCouldAlterARequest() async throws {
		let api = FakePausing()
		let paused = await (try pauser(signedInWorkspace: "ws", api: api)).pause(sessionIds: ["ok-1", "a/b", "x y"], workspaceId: "ws")
		#expect(paused == ["ok-1"])
	}
}

@MainActor
@Suite("AgentsActivityRuntime")
struct AgentsActivityRuntimeTests {
	@MainActor
	private final class FakeHost: AgentsActivityHosting {
		var log: [String] = []
		func activeIdentity() -> AgentsActivityIdentity? { nil }
		func start(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async { log.append("start:\(identity.workspaceId):\(state.count)") }
		func update(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async { log.append("update:\(state.count)") }
		func end(_ identity: AgentsActivityIdentity, state: AgentsActivityState, dismissAfter: TimeInterval) async { log.append("end") }
		func endAll() async { log.append("endAll") }
	}

	private actor NoTokens: LiveActivityTokenRegistering {
		func register(kind: LiveActivityTokenKind, deviceId: String, sessionId: String?, token: String) async throws -> String { "t" }
		func unregister(tokenId: String, credentials: APILiveActivityTokens.Credentials?) async throws {}
	}

	@Test func buildsAFeedPerWorkspaceAndTearsItDownOnSignOut() async {
		let host = FakeHost()
		let coordinator = AgentsActivityCoordinator(host: host, tokens: NoTokens())
		let api = FakeAgentsAPI([agentRow("forge")], sessions: [agentSession("s1", actor: "forge", status: "running")])
		let box = MadeBox()
		let runtime = AgentsActivityRuntime(coordinator: coordinator) { workspaceId, coordinator in
			box.made.append(workspaceId)
			return WorkingAgentsFeed(api: api, events: nil) { agents in await coordinator.feedChanged(agents) }
		}
		await runtime.sessionChanged(workspaceId: "ws")
		await runtime.sessionChanged(workspaceId: "ws")  // idempotent
		#expect(box.made == ["ws"])
		#expect(host.log == ["endAll", "start:ws:1"])
		await runtime.sessionChanged(workspaceId: nil)
		#expect(host.log.last == "endAll")
		#expect(runtime.feed == nil)
	}

	@MainActor
	private final class MadeBox { var made: [String] = [] }
}
