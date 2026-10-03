import Testing

@testable import MaskinCore

@Suite("Agent routines lookup")
struct AgentRoutinesTests {
	private func loop(_ id: String, agents: [String], triggers: [String] = []) -> LoopSummary {
		LoopSummary(id: id, name: id, agentIDs: agents, triggerIDs: triggers)
	}

	private func trigger(_ id: String, target: String) -> Trigger {
		Trigger(id: id, name: id, kind: .cron, targetActorID: target)
	}

	@Test("keeps loops that run one of the agents and drops the rest")
	func matchesLoops() {
		let result = AgentRoutines.lookup(
			agentIDs: ["a1"],
			loops: [loop("l1", agents: ["a1", "a2"]), loop("l2", agents: ["a3"])], triggers: [])
		#expect(result.loops.map(\.id) == ["l1"])
	}

	@Test("a trigger already inside a matched loop is not listed twice")
	func foldsCoveredTriggers() {
		let result = AgentRoutines.lookup(
			agentIDs: ["a1"], loops: [loop("l1", agents: ["a1"], triggers: ["t1"])],
			triggers: [trigger("t1", target: "a1"), trigger("t2", target: "a1")])
		#expect(result.triggers.map(\.id) == ["t2"])
	}

	@Test("triggers aimed at other agents are ignored")
	func ignoresOtherTargets() {
		let result = AgentRoutines.lookup(
			agentIDs: ["a1"], loops: [], triggers: [trigger("t1", target: "a2")])
		#expect(result.isEmpty)
	}

	@Test("no agents in the thread means no routines")
	func noAgents() {
		let result = AgentRoutines.lookup(
			agentIDs: [], loops: [loop("l1", agents: ["a1"])], triggers: [trigger("t1", target: "a1")])
		#expect(result.isEmpty)
	}
}
