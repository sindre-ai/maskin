import Foundation
import Testing

@testable import MaskinCore

@Suite("AgentsWorkingState")
struct AgentsWorkingStateTests {
	private func agent(
		_ name: String, eta: Int? = nil, sensitive: Bool = false, what: String = "working on it"
	) -> WorkingAgent {
		WorkingAgent(id: name, name: name, what: what, etaMinutes: eta, sensitive: sensitive)
	}

	@Test("ranks by soonest finish, then customer-facing or production work, unknown ETAs last")
	func ranking() {
		let ranked = AgentsWorkingState.rank([
			agent("Zed", eta: 30), agent("Quiet", eta: 5), agent("Prod", eta: 5, sensitive: true),
			agent("Unknown"), agent("Alpha", eta: 5),
		])
		#expect(ranked.map(\.name) == ["Prod", "Alpha", "Quiet", "Zed", "Unknown"])
	}

	@Test("one agent reads as a sentence; several as a count with how many finish soon")
	func headlines() {
		let one = AgentsWorkingState.make(from: [agent("Forge", eta: 6, what: "rolling out Retry policy v2")])
		#expect(one.layout == .single)
		#expect(one.headline == "Forge is rolling out Retry policy v2")
		#expect(one.compactCount == nil)

		let many = AgentsWorkingState.make(
			from: (1...23).map { agent("A\($0)", eta: $0 <= 3 ? 10 : 90) })
		#expect(many.layout == .many)
		#expect(many.total == 23)
		#expect(many.headline == "23 agents working \u{00B7} 3 finish in 15 min")
		#expect(many.compactCount == "23")
		#expect(many.rows.count == 3)
		#expect(many.compactAvatars.count == 3)
	}

	@Test("no one finishing soon leaves the headline plain; none working ends the activity")
	func plainAndEmpty() {
		let slow = AgentsWorkingState.make(from: [agent("A", eta: 60), agent("B", eta: 90)])
		#expect(slow.headline == "2 agents working")
		#expect(AgentsWorkingState.make(from: []).isEmpty)
	}

	@Test("durations read as minutes, then hours")
	func durations() {
		#expect(WorkingAgent(id: "a", name: "A", what: "x", etaMinutes: 6).etaLabel == "6 min")
		#expect(WorkingAgent(id: "a", name: "A", what: "x", etaMinutes: 65).etaLabel == "1 h 5 min")
		#expect(WorkingAgent(id: "a", name: "A", what: "x", etaMinutes: 120).etaLabel == "2 h")
		#expect(WorkingAgent(id: "a", name: "A", what: "x").etaLabel == "")
	}

	@Test("names and sentences are clamped so the island never overflows")
	func clamping() {
		let long = WorkingAgent(
			id: "a", name: String(repeating: "N", count: 80), what: String(repeating: "w", count: 200))
		#expect(long.name.count == WorkingAgent.maxNameLength)
		#expect(long.what.count == WorkingAgent.maxWhatLength)
	}
}
