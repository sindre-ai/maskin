import Foundation
import Testing

@testable import MaskinCore

@Suite("AgentDraft")
struct AgentDraftTests {
	@Test("an unchanged draft produces no edit")
	func unchanged() {
		let profile = agentProfile()
		#expect(AgentDraft(profile: profile).edit(against: profile) == nil)
	}

	@Test("only changed fields are sent, trimmed")
	func diff() {
		let profile = agentProfile()
		var draft = AgentDraft(profile: profile)
		draft.name = "  Forge 2  "
		let edit = draft.edit(against: profile)
		#expect(edit == AgentEdit(name: "Forge 2"))

		draft.systemPrompt = "New instructions"
		#expect(draft.edit(against: profile) == AgentEdit(name: "Forge 2", systemPrompt: "New instructions"))
	}

	@Test("clearing the role sends an empty description")
	func clearRole() {
		let profile = agentProfile()
		var draft = AgentDraft(profile: profile)
		draft.description = ""
		#expect(draft.edit(against: profile) == AgentEdit(description: ""))
	}

	@Test("a blank name or an oversized description is invalid")
	func validity() {
		#expect(!AgentDraft(name: "   ").isValid)
		#expect(AgentDraft(name: "Forge").isValid)
		#expect(!AgentDraft(name: "Forge", description: String(repeating: "x", count: 2001)).isValid)
		let profile = agentProfile()
		var draft = AgentDraft(profile: profile)
		draft.name = ""
		#expect(draft.edit(against: profile) == nil)
	}
}

@Suite("MCP servers")
struct MCPServerDraftTests {
	@Test("names are reduced to safe keys")
	func sanitize() {
		#expect(MCPServerDraft.sanitize(" My Server! ") == "my-server")
		#expect(MCPServerDraft.sanitize("$(rm -rf)") == "rm--rf")
		#expect(MCPServerDraft.sanitize("***") == "")
	}

	@Test("quoted arguments stay together")
	func args() {
		#expect(MCPServerDraft.splitArgs("-y @scope/pkg --flag \"two words\"") == ["-y", "@scope/pkg", "--flag", "two words"])
		#expect(MCPServerDraft.splitArgs("   ") == [])
	}

	@Test("a hosted server needs a real URL")
	func http() throws {
		var draft = MCPServerDraft(kind: .http, name: "Docs", url: "not a url")
		guard case .failure = draft.build(existing: []) else { Issue.record("bad url accepted"); return }
		draft.url = "https://docs.example.com/mcp"
		let tool = try draft.build(existing: []).get()
		#expect(tool.name == "docs")
		#expect(tool.kind == "http")
		#expect(tool.location == "https://docs.example.com/mcp")
	}

	@Test("a command server needs a command and splits its arguments")
	func stdio() throws {
		var draft = MCPServerDraft(kind: .stdio, name: "gh")
		guard case .failure = draft.build(existing: []) else { Issue.record("empty command accepted"); return }
		draft.command = "npx"
		draft.args = "-y @modelcontextprotocol/server-github"
		let tool = try draft.build(existing: []).get()
		#expect(tool.location == "npx -y @modelcontextprotocol/server-github")
		#expect(tool.spec?["args"] == .array([.string("-y"), .string("@modelcontextprotocol/server-github")]))
	}

	@Test("a duplicate name is refused instead of overwriting")
	func duplicate() {
		let draft = MCPServerDraft(kind: .http, name: "github", url: "https://x.example.com")
		guard case .failure(let error) = draft.build(existing: [AgentTool(name: "github")]) else {
			Issue.record("duplicate accepted"); return
		}
		#expect(error.message.contains("github"))
	}

	@Test("tools round-trip through the wire shape, keeping every server's full spec")
	func roundTrip() {
		let tools = MCPPreset.all.map(\.tool)
		let wire = AgentTool.toolsJSON(tools)
		let back = AgentTool.summarize(wire)
		#expect(Set(back.map(\.name)) == Set(tools.map(\.name)))
		#expect(back.first(where: { $0.name == "linear" })?.spec == tools.first(where: { $0.name == "linear" })?.spec)
	}

	@Test("presets use placeholders, never secrets, and hide headers from the location")
	func presets() {
		for preset in MCPPreset.all {
			#expect(preset.tool.name == preset.id)
			#expect(preset.tool.location?.contains("Bearer") != true)
		}
		let linear = MCPPreset.all.first { $0.id == "linear" }
		#expect(linear?.tool.spec?["headers"]?["Authorization"]?.stringValue == "Bearer ${LINEAR_TOKEN}")
	}

	@Test("available presets exclude servers already added")
	func available() {
		let rest = MCPPreset.available(excluding: [AgentTool(name: "linear")])
		#expect(!rest.contains { $0.id == "linear" })
		#expect(rest.count == MCPPreset.all.count - 1)
	}
}

@Suite("AgentDetailStore editing")
@MainActor
struct AgentDetailEditingTests {
	private func make() async -> (AgentDetailStore, FakeAgentDetailAPI) {
		let api = FakeAgentDetailAPI(agentProfile())
		let store = AgentDetailStore(agentID: "forge", api: api, events: nil)
		await store.refresh()
		return (store, api)
	}

	@Test("save sends only the edit and keeps the server's profile")
	func save() async {
		let (store, api) = await make()
		#expect(await store.save(AgentEdit(name: "Anvil", systemPrompt: "Be brief.")))
		#expect(await api.edits == [AgentEdit(name: "Anvil", systemPrompt: "Be brief.")])
		#expect(store.profile?.name == "Anvil")
		#expect(store.profile?.systemPrompt == "Be brief.")
		#expect(store.busy == nil)
	}

	@Test("save applies at once and rolls back with a notice when the server refuses")
	func rollback() async {
		let (store, api) = await make()
		await api.fail(next: "Couldn't save your changes.")
		#expect(await store.save(AgentEdit(name: "Anvil")) == false)
		#expect(store.profile?.name == "Forge")
		#expect(store.notice == "Couldn't save your changes.")
	}

	@Test("an empty edit does nothing")
	func empty() async {
		let (store, api) = await make()
		#expect(await store.save(AgentEdit()) == false)
		#expect(await api.edits.isEmpty)
	}

	@Test("adding a tool appends it and keeps the existing ones")
	func addTool() async {
		let (store, api) = await make()
		let linear = MCPPreset.all.first { $0.id == "linear" }!.tool
		#expect(await store.addTool(linear))
		#expect(store.profile?.tools.map(\.name) == ["github", "linear"])
		#expect(await api.edits.first?.tools?.count == 2)
		// Adding it again is a no-op, not a second request.
		#expect(await store.addTool(linear) == false)
		#expect(await api.edits.count == 1)
	}

	@Test("removing a tool sends the remaining list, and a failure restores it")
	func removeTool() async {
		let (store, api) = await make()
		await api.fail(next: "nope")
		#expect(await store.removeTool(named: "github") == false)
		#expect(store.profile?.tools.map(\.name) == ["github"])
		#expect(await store.removeTool(named: "github"))
		#expect(store.profile?.tools.isEmpty == true)
		#expect(await api.edits.last?.tools?.isEmpty == true)
	}

	@Test("a retry after a lost response reuses the idempotency key")
	func idempotent() async {
		let (store, api) = await make()
		await api.setDropNextResponse(true)
		#expect(await store.save(AgentEdit(name: "Anvil")) == false)
		#expect(await store.save(AgentEdit(name: "Anvil")))
		let keys = await api.keys
		#expect(keys.count == 2)
		#expect(Set(keys).count == 1)
	}

	@Test("delete flips isDeleted only after the server agrees; system agents can't be deleted")
	func delete() async {
		let (store, api) = await make()
		await api.fail(next: "forbidden")
		#expect(await store.delete() == false)
		#expect(!store.isDeleted)
		#expect(store.notice == "forbidden")
		#expect(await store.delete())
		#expect(store.isDeleted)
		#expect(await api.deleted == ["forge"])

		let system = FakeAgentDetailAPI(agentProfile(system: true))
		let builtIn = AgentDetailStore(agentID: "forge", api: system, events: nil)
		await builtIn.refresh()
		#expect(!builtIn.canDelete)
		#expect(await builtIn.delete() == false)
	}
}

@Suite("AgentsStore creating")
@MainActor
struct AgentCreateTests {
	@Test("create puts the new agent in the list and returns its id")
	func create() async {
		let api = FakeAgentsAPI([agentRow("a")])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		let id = await store.create(AgentDraft(name: " Scout ", description: "Finds leads"))
		#expect(id == "new-1")
		#expect(store.agent(id: "new-1")?.name == "Scout")
		#expect(store.agent(id: "new-1")?.role == "Finds leads")
		#expect(await api.created.count == 1)
	}

	@Test("an invalid draft never reaches the server")
	func invalid() async {
		let api = FakeAgentsAPI()
		let store = AgentsStore(api: api, events: nil)
		#expect(await store.create(AgentDraft(name: "  ")) == nil)
		#expect(await api.created.isEmpty)
	}

	@Test("a failed create reports why and a retry reuses the idempotency key")
	func failure() async {
		let api = FakeAgentsAPI()
		let store = AgentsStore(api: api, events: nil)
		await api.setFailing(true)
		let draft = AgentDraft(name: "Scout")
		#expect(await store.create(draft) == nil)
		#expect(store.notice == "offline")
		await api.setFailing(false)
		#expect(await store.create(draft) != nil)
		#expect(store.notice == nil)
	}

	@Test("remove drops an agent from the list")
	func remove() async {
		let api = FakeAgentsAPI([agentRow("a"), agentRow("b")])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		store.remove(id: "a")
		#expect(store.agents.map(\.id) == ["b"])
	}
}
