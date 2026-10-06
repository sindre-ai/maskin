import Foundation
import Testing

@testable import MaskinCore

@Suite("AgentDetailStore")
@MainActor
struct AgentDetailStoreTests {
	private func make(
		_ profile: AgentProfile = agentProfile(), sessions: [AgentSession] = []
	) async -> (AgentDetailStore, FakeAgentDetailAPI) {
		let api = FakeAgentDetailAPI(profile, sessions: sessions)
		let store = AgentDetailStore(agentID: profile.id, api: api, events: nil)
		await store.refresh()
		return (store, api)
	}

	@Test("loads profile and sessions")
	func load() async {
		let (store, _) = await make(sessions: [agentSession("s1", actor: "forge")])
		#expect(store.phase == .loaded)
		#expect(store.profile?.name == "Forge")
		#expect(store.profile?.role == "Ships fixes")
		#expect(store.profile?.tools.map(\.name) == ["github"])
		#expect(store.sessions.count == 1)
		#expect(store.status == .idle)
	}

	@Test("run sends the trimmed prompt and the agent becomes working")
	func run() async {
		let (store, api) = await make()
		#expect(await store.run(prompt: "  fix the build \n"))
		#expect(await api.runPrompts == ["fix the build"])
		#expect(store.status == .running)
		#expect(store.liveSession?.id == "new")
		#expect(store.busy == nil)
	}

	@Test("a blank prompt runs with the default instructions")
	func runBlank() async {
		let (store, api) = await make()
		await store.run(prompt: "   ")
		#expect(await api.runPrompts == [nil])
	}

	@Test("run rolls back and reports when the server refuses")
	func runRollback() async {
		let (store, api) = await make()
		await api.fail(next: "This agent can't run right now.")
		#expect(await store.run(prompt: "x") == false)
		#expect(store.status == .idle)
		#expect(store.notice == "This agent can't run right now.")
		#expect(store.busy == nil)
	}

	@Test("the optimistic state is visible while the request is in flight")
	func optimistic() async {
		let (store, api) = await make(agentProfile(state: .running), sessions: [agentSession("s1", actor: "forge", status: "running")])
		await api.setDelay(.milliseconds(300))
		let task = Task { await store.pause() }
		#expect(await eventually { store.busy == .pause })
		#expect(store.status == .paused)
		#expect(store.liveSession?.isPaused == true)
		#expect(store.canPause == false)
		#expect(await task.value)
		#expect(store.status == .paused)
	}

	@Test("pause rolls back to running when refused")
	func pauseRollback() async {
		let (store, api) = await make(agentProfile(state: .running), sessions: [agentSession("s1", actor: "forge", status: "running")])
		await api.fail(next: "Couldn't pause the agent.")
		#expect(await store.pause() == false)
		#expect(store.status == .running)
		#expect(store.sessions.first?.status == "running")
		#expect(store.notice == "Couldn't pause the agent.")
	}

	@Test("a paused agent resumes through run")
	func resume() async {
		let (store, api) = await make(agentProfile(state: .paused))
		#expect(store.canRun)
		#expect(store.canPause == false)
		await store.run(prompt: nil)
		#expect(await api.runPrompts == [nil])
		#expect(store.status == .running)
	}

	@Test("reset is only offered for system agents")
	func resetGate() async {
		let (user, userAPI) = await make(agentProfile(system: false))
		#expect(user.canReset == false)
		#expect(await user.reset() == false)
		#expect(await userAPI.resetCalls == 0)
		let (system, systemAPI) = await make(agentProfile("coach", system: true))
		#expect(await system.reset())
		#expect(await systemAPI.resetCalls == 1)
	}

	@Test("reset failure leaves the profile as it was")
	func resetRollback() async {
		let (store, api) = await make(agentProfile("coach", state: .failed, system: true))
		await api.fail(next: "Only built-in agents can be reset.")
		#expect(await store.reset() == false)
		#expect(store.profile?.storedState == .failed)
		#expect(store.notice == "Only built-in agents can be reset.")
	}

	@Test("stopping a session removes it from the live set; failure restores it")
	func stop() async {
		let (store, api) = await make(agentProfile(state: .running), sessions: [agentSession("s1", actor: "forge", status: "running")])
		await api.fail(next: "Couldn't stop the session.")
		#expect(await store.stopSession("s1") == false)
		#expect(store.sessions.first?.status == "running")
		#expect(store.notice == "Couldn't stop the session.")
		store.notice = nil
		await api.set(profile: agentProfile(state: .idle))
		#expect(await store.stopSession("s1"))
		#expect(await api.stopped == ["s1"])
		#expect(store.liveSession == nil)
	}

	@Test("only live sessions can be stopped")
	func stopFinished() async {
		let (store, api) = await make(sessions: [agentSession("s1", actor: "forge", status: "completed")])
		#expect(await store.stopSession("s1") == false)
		#expect(await api.stopped.isEmpty)
	}

	@Test("a session event for this agent refetches")
	func live() async {
		let api = FakeAgentDetailAPI(agentProfile())
		let hub = scriptedHub([conversationFrame(1, conversation: "s1", action: "updated", entity: "session")])
		let store = AgentDetailStore(agentID: "forge", api: api, events: hub)
		await store.start()
		await api.set(sessions: [agentSession("s1", actor: "forge", status: "running")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.status == .running })
		store.stop()
	}

	@Test("a failed first load shows the error")
	func failedLoad() async {
		struct Down: AgentDetailAPI {
			func profile(agentID: String) async throws -> AgentProfile { throw AgentsError("nope") }
			func sessions(agentID: String, limit: Int) async throws -> [AgentSession] { [] }
			func run(agentID: String, prompt: String?, idempotencyKey: String) async throws -> AgentStatus { .idle }
			func pause(agentID: String, idempotencyKey: String) async throws -> AgentStatus { .idle }
			func reset(agentID: String, idempotencyKey: String) async throws -> AgentStatus { .idle }
			func stop(sessionID: String, idempotencyKey: String) async throws {}
		}
		let store = AgentDetailStore(agentID: "x", api: Down(), events: nil)
		await store.refresh()
		#expect(store.phase == .failed("nope"))
	}

	@Test("retrying a run after a lost response reuses the idempotency key")
	func runKeyReused() async {
		let (store, api) = await make()
		await api.setDropNextResponse(true)
		#expect(await store.run(prompt: "go") == false)
		#expect(await store.run(prompt: "go"))
		let keys = await api.keys
		#expect(keys.count == 2)
		#expect(keys[0] == keys[1])
	}

	@Test("a finished run gets a fresh key next time, and pause carries a key")
	func keysAreFreshAfterSuccess() async {
		let (store, api) = await make()
		#expect(await store.run(prompt: "a"))
		#expect(await store.pause())
		#expect(await store.run(prompt: "a"))
		let keys = await api.keys
		#expect(keys.count == 3)
		#expect(Set(keys).count == 3)
	}
}
