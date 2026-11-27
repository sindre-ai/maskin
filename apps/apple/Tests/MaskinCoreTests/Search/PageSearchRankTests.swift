import Foundation
import Testing

@testable import MaskinCore

/// Answers with a fixed id list per query, and can be held or made to fail.
private actor FakeRanking: PageSearchRanking {
	var answers: [String: [String]]
	var fails = false
	private(set) var asked: [(query: String, type: PageSearchType)] = []

	init(_ answers: [String: [String]]) { self.answers = answers }

	func setFails(_ value: Bool) { fails = value }

	func rankedIDs(query: String, type: PageSearchType) async throws -> [String] {
		asked.append((query, type))
		if fails { throw SearchError("Search failed.") }
		return answers[query] ?? []
	}
}

@MainActor
@Suite("Agents and Flows page search order")
struct PageSearchRankTests {
	private func waitForOrder(_ rank: PageSearchRank) async {
		for _ in 0..<200 where rank.order == nil { try? await Task.sleep(for: .milliseconds(10)) }
	}

	@Test("ranked rows come first in the server's order, the rest keep their place after them")
	func sortKeepsUnrankedAfter() {
		let rows = ["a", "b", "c", "d"]
		#expect(PageSearchRank.sort(rows, by: nil, id: { $0 }) == rows)
		#expect(PageSearchRank.sort(rows, by: ["c": 0, "a": 1], id: { $0 }) == ["c", "a", "b", "d"])
		#expect(PageSearchRank.sort(rows, by: ["d": 0], id: { $0 }) == ["d", "a", "b", "c"])
	}

	@Test("typing asks the server for this page's type and sets the order")
	func typingSetsOrder() async {
		let remote = FakeRanking(["cco": ["agent-cco", "agent-alpha"]])
		let rank = PageSearchRank(remote: remote, type: .agent, debounce: .milliseconds(1))
		rank.update(text: " cco ")
		await waitForOrder(rank)
		#expect(rank.order == ["agent-cco": 0, "agent-alpha": 1])
		let asked = await remote.asked
		#expect(asked.map { $0.query } == ["cco"], "the words are trimmed")
		#expect(asked.map { $0.type } == [.agent])
	}

	@Test("clearing the box drops the order, so the Display order comes back")
	func clearing() async {
		let rank = PageSearchRank(
			remote: FakeRanking(["cco": ["x"]]), type: .loop, debounce: .milliseconds(1))
		rank.update(text: "cco")
		await waitForOrder(rank)
		#expect(rank.order != nil)
		rank.update(text: "   ")
		#expect(rank.order == nil)
	}

	@Test("new words drop the old order at once")
	func newWordsDropOldOrder() async {
		let rank = PageSearchRank(
			remote: FakeRanking(["cco": ["x"], "ccoo": ["y"]]), type: .loop, debounce: .milliseconds(1))
		rank.update(text: "cco")
		await waitForOrder(rank)
		rank.update(text: "ccoo")
		#expect(rank.order == nil)
		await waitForOrder(rank)
		#expect(rank.order == ["y": 0])
	}

	@Test("a failed search leaves the Display order")
	func failure() async {
		let remote = FakeRanking([:])
		await remote.setFails(true)
		let rank = PageSearchRank(remote: remote, type: .agent, debounce: .milliseconds(1))
		rank.update(text: "cco")
		try? await Task.sleep(for: .milliseconds(100))
		#expect(rank.order == nil)
	}

	@Test("the agents list puts the name match first while ranked, and the Display order back when not")
	func agentsList() async {
		let api = FakeAgentsAPI([
			agentRow("alpha", name: "Alpha", description: "Works with cco on hiring"),
			agentRow("cco", name: "CCO", description: "Commercial"),
		])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		let display = AgentsDisplay(sort: .name, grouping: .none)
		#expect(store.sections(query: "cco", display: display)[0].items.map(\.id) == ["alpha", "cco"])
		let ranked = store.sections(query: "cco", display: display, rank: ["cco": 0, "alpha": 1])
		#expect(ranked[0].items.map(\.id) == ["cco", "alpha"])
		#expect(store.sections(query: "", display: display)[0].items.map(\.id) == ["alpha", "cco"])
	}

	@Test("a ranking also replaces the grouping, so the best match is the first row")
	func agentsRankingDropsGroups() async {
		let api = FakeAgentsAPI([
			agentRow("a", name: "Alpha cco", tags: ["Team one"]), agentRow("b", name: "Beta cco", tags: ["Team two"]),
		])
		let store = AgentsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.sections(query: "cco", display: .default).count == 2)
		let ranked = store.sections(query: "cco", display: .default, rank: ["b": 0, "a": 1])
		#expect(ranked.count == 1 && ranked[0].title == nil)
		#expect(ranked[0].items.map(\.id) == ["b", "a"])
	}

	@Test("the flows list puts the server's best match first while ranked")
	func flowsList() async {
		let store = LoopsStore(
			api: FakeLoopsAPI([loopRow("a", name: "Alpha cco growth"), loopRow("b", name: "CCO pipeline")]),
			events: nil)
		await store.start()
		let plain = store.filtered(query: "cco").map(\.id)
		#expect(Set(plain) == ["a", "b"])
		#expect(store.filtered(query: "cco", rank: ["b": 0, "a": 1]).map(\.id) == ["b", "a"])
		#expect(store.filtered(query: "cco", rank: ["a": 0, "b": 1]).map(\.id) == ["a", "b"])
	}
}
