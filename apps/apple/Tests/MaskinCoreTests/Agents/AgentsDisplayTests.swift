import Foundation
import Testing

@testable import MaskinCore

@Suite("AgentsStore display, teams and chips")
@MainActor
struct AgentsDisplayTests {
	/// Four agents: two in "Product Delivery" (one failed), one in "SEO Content", one untagged.
	private func make() async -> AgentsStore {
		let api = FakeAgentsAPI(
			[
				agentRow("dev", name: "Developer", tags: ["Product Delivery"]),
				agentRow("rev", name: "Code Reviewer", tags: ["Product Delivery"]),
				agentRow("seo", name: "SEO Writer", tags: ["SEO Content"]), agentRow("solo", name: "Chief of Staff"),
			],
			sessions: [
				agentSession("s1", actor: "dev", status: "running", at: 20),
				agentSession("s2", actor: "dev", status: "completed", at: 10),
				agentSession("s3", actor: "rev", status: "failed", at: 5),
			])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		return store
	}

	@Test("a team is the agent's first tag; no tag means No team")
	func teams() async {
		let store = await make()
		#expect(store.team(of: "dev") == "Product Delivery")
		#expect(store.team(of: "solo") == AgentTeams.none)
		#expect(store.teamChips().map(\.label) == ["Product Delivery", "SEO Content", "No team"])
		#expect(store.teamChips().map(\.count) == [2, 1, 1])
	}

	@Test("by default the list is grouped by team and sorted needs-attention first")
	func defaultSections() async {
		let sections = await make().sections()
		#expect(sections.map(\.title) == ["Product Delivery", "SEO Content", "No team"])
		#expect(sections[0].items.map(\.id) == ["rev", "dev"])
	}

	@Test("group by status puts failed under Needs attention first")
	func groupByStatus() async {
		let sections = await make().sections(display: AgentsDisplay(grouping: .status))
		#expect(sections.map(\.title) == ["Needs attention", "Working", "Idle"])
	}

	@Test("group by none is one untitled section, sorted by name or by sessions")
	func ungrouped() async {
		let store = await make()
		let byName = store.sections(display: AgentsDisplay(sort: .name, grouping: .none))
		#expect(byName.count == 1 && byName[0].title == nil)
		#expect(byName[0].items.map(\.id) == ["solo", "rev", "dev", "seo"])
		let bySessions = store.sections(display: AgentsDisplay(sort: .sessions, grouping: .none))
		#expect(bySessions[0].items.first?.id == "dev")
		let reversed = store.sections(display: AgentsDisplay(sort: .name, reversed: true, grouping: .none))
		#expect(reversed[0].items.map(\.id) == ["seo", "dev", "rev", "solo"])
	}

	@Test("status and team filters narrow the list, and one team drops its header")
	func filters() async {
		let store = await make()
		let failed = store.sections(display: AgentsDisplay(status: .failed))
		#expect(failed.flatMap(\.items).map(\.id) == ["rev"])
		let team = store.sections(display: AgentsDisplay(team: "Product Delivery"))
		#expect(team.count == 1 && team[0].title == nil)
		#expect(team[0].items.count == 2)
		#expect(store.sections(query: "zzz").isEmpty)
	}

	@Test("status chips count within the chosen team; Disabled only appears when something is")
	func statusChips() async {
		let store = await make()
		let all = store.statusChips(team: nil)
		#expect(all.map(\.label) == ["All", "Working", "Idle", "Failed"])
		#expect(all.map(\.count) == [4, 1, 2, 1])
		#expect(store.statusChips(team: "SEO Content").map(\.count) == [1, 0, 1, 0])
	}

	@Test("a row shows its team only when not grouped by team, and latest on request")
	func rowLines() async {
		#expect(AgentsDisplay().rowShowsTeam == false)
		#expect(AgentsDisplay(grouping: .status).rowShowsTeam)
		#expect(AgentsDisplay(grouping: .status, showsTeam: false).rowShowsTeam == false)
		let store = await make()
		#expect(store.agent(id: "rev")?.latestLine() == "Last run failed")
		#expect(store.agent(id: "solo")?.latestLine() == "Standing by")
		#expect(AgentsDisplay().isCustomized == false)
		#expect(AgentsDisplay(showsLatest: true).isCustomized)
	}

	@Test("tags that differ only in case are one team; digits sort by value")
	func caseAndNumbers() {
		let teams = AgentTeams.teams(of: [
			agentRow("a", tags: ["alpha"]), agentRow("b", tags: ["Alpha"]),
			agentRow("c", tags: ["Team 10", "Team 2"]), agentRow("d"),
		])
		#expect(teams["a"] == "Alpha")
		#expect(teams["b"] == "Alpha")
		#expect(teams["c"] == "Team 2")
		#expect(teams["d"] == AgentTeams.none)
	}
}
