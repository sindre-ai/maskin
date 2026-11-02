import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("LoopTriggerLine")
struct LoopTriggerLineTests {
	@Test("then is the first non-empty line of the instruction")
	func thenFromPrompt() {
		let step = LoopStep(triggerID: "t1", name: "Triage", actionPrompt: "\n  Sort new mail  \nThen label it", agentName: "Relay")
		#expect(LoopTriggerLine(step: step).then == "Sort new mail")
	}

	@Test("then falls back to who picks it up when there is no instruction")
	func thenFallsBackToAgent() {
		let step = LoopStep(triggerID: "t1", name: "Triage", actionPrompt: "  \n ", agentName: "Relay")
		#expect(LoopTriggerLine(step: step).then == "Relay picks it up.")
	}

	@Test("then is nil with no instruction and no agent")
	func thenNil() {
		#expect(LoopTriggerLine(step: LoopStep(triggerID: "t1", name: nil)).then == nil)
	}

	@Test("run by names one, two or three agents and drops duplicates")
	func runByFormatting() {
		#expect(LoopTriggerLine.runBy([]) == nil)
		#expect(LoopTriggerLine.runBy(["A"]) == "Run by A")
		#expect(LoopTriggerLine.runBy(["A", "B"]) == "Run by A and B")
		#expect(LoopTriggerLine.runBy(["A", "B", "C"]) == "Run by A, B and C")
		#expect(LoopTriggerLine.runBy(["A", "B", "A"]) == "Run by A and B")
	}
}
