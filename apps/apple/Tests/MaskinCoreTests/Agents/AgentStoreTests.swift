import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@Suite("AgentsStore")
@MainActor
struct AgentsStoreTests {
	@Test("loads agents and attaches the latest session, preferring a live one")
	func load() async {
		let api = FakeAgentsAPI(
			[agentRow("forge"), agentRow("relay")],
			sessions: [
				agentSession("s1", actor: "forge", status: "completed", at: 50),
				agentSession("s2", actor: "forge", status: "running", at: 10),
				agentSession("s3", actor: "relay", status: "completed", at: 5),
			])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.phase == .loaded)
		let forge = store.agent(id: "forge")
		#expect(forge?.latestSession?.id == "s2")
		#expect(forge?.sessionCount == 2)
		#expect(forge?.status == .running)
		#expect(store.agent(id: "relay")?.latestSession?.id == "s3")
		#expect(store.workingCount == 1)
	}

	@Test("groups by state in web order and sorts by name")
	func grouping() async {
		let api = FakeAgentsAPI(
			[
				agentRow("zed", state: .idle), agentRow("amy", state: .idle),
				agentRow("pat", state: .paused), agentRow("bob", state: .failed),
				agentRow("run", state: .idle),
			],
			sessions: [agentSession("s", actor: "run", status: "running")])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		let groups = store.groups()
		#expect(groups.map(\.status) == [.running, .paused, .idle, .failed])
		#expect(groups[2].items.map(\.name) == ["Amy", "Zed"])
	}

	@Test("a failed last run reads as failed even when the stored state is idle")
	func failedFromSession() async {
		let api = FakeAgentsAPI(
			[agentRow("forge")], sessions: [agentSession("s", actor: "forge", status: "timeout")])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.agent(id: "forge")?.status == .failed)
	}

	@Test("search matches name and role")
	func search() async {
		let api = FakeAgentsAPI([
			agentRow("forge", description: "Ships fixes"), agentRow("relay", description: "Routes mail"),
		])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.groups(query: "fix").flatMap(\.items).map(\.id) == ["forge"])
		#expect(store.groups(query: "RELAY").flatMap(\.items).map(\.id) == ["relay"])
		#expect(store.groups(query: "zzz").isEmpty)
	}

	@Test("role is the first line of the description, falling back to Agent")
	func role() {
		#expect(agentRow("a", description: "  Ships fixes \nmore").role == "Ships fixes")
		#expect(agentRow("a", description: nil).role == "Agent")
		#expect(agentRow("a", description: "").role == "Agent")
	}

	@Test("a first-load failure surfaces; a later failure keeps the list")
	func failure() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		await api.setFailing(true)
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.phase == .failed("offline"))
		await api.setFailing(false)
		await store.refresh()
		#expect(store.agents.count == 1)
		await api.setFailing(true)
		await store.refresh()
		#expect(store.phase == .loaded)
		#expect(store.agents.count == 1)
	}

	@Test("an actor event refetches the list")
	func liveActor() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		let hub = scriptedHub([conversationFrame(1, conversation: "forge", action: "updated", entity: "actor")])
		let store = AgentsStore(api: api, events: hub, debounce: .zero, sleep: { _ in })
		await store.start()
		await api.set([agentRow("forge", state: .paused), agentRow("relay")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.agents.count == 2 })
		store.stop()
	}

	@Test("a session event refetches so working state follows")
	func liveSession() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		let hub = scriptedHub([conversationFrame(1, conversation: "s1", action: "created", entity: "session")])
		let store = AgentsStore(api: api, events: hub, debounce: .zero, sleep: { _ in })
		await store.start()
		await api.set(sessions: [agentSession("s1", actor: "forge", status: "running")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.agent(id: "forge")?.status == .running })
		store.stop()
	}

	@Test("the list reloads after the stream reconnects")
	func reconnect() async {
		let api = FakeAgentsAPI([agentRow("a")])
		let hub = scriptedHub([
			"id: 1\nevent: x\ndata: {\"entity_type\":\"object\",\"workspace_id\":\"w1\",\"event_id\":\"1\"}\n\n", "",
		])
		let store = AgentsStore(api: api, events: hub, debounce: .zero, sleep: { _ in })
		await store.start()
		await api.set([agentRow("a"), agentRow("b")])
		hub.connect(workspaceId: "w1")
		#expect(await eventually { store.agents.count == 2 })
		store.stop()
	}
}

@Suite("AgentTool")
struct AgentToolTests {
	@Test("summarises mcpServers by name and transport")
	func summarize() {
		let tools: JSONValue = .object([
			"mcpServers": .object([
				"slack": .object(["type": .string("http")]),
				"github": .object(["command": .string("npx")]),
			])
		])
		let found = AgentTool.summarize(tools)
		#expect(found.map(\.name) == ["github", "slack"])
		#expect(found.map(\.kind) == ["stdio", "http"])
		#expect(AgentTool.summarize(nil).isEmpty)
		#expect(AgentTool.summarize(.object([:])).isEmpty)
	}
}
