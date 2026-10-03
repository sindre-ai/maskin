import Foundation
import Testing

@testable import MaskinCore

@Suite("SessionActivity")
struct SessionActivityTests {
	@Test("done and failed are final, the rest keep the activity up")
	func finalPhases() {
		#expect(SessionActivityPhase.done.isFinal && SessionActivityPhase.failed.isFinal)
		let live: [SessionActivityPhase] = [.running, .needsYou, .paused]
		#expect(live.allSatisfy { !$0.isFinal })
	}

	@Test("a step is cut to 40 characters")
	func stepIsBounded() {
		let state = SessionActivityState(phase: .running, step: String(repeating: "x", count: 200))
		#expect(state.step?.count == SessionActivityState.maxStepLength)
	}

	@Test("task is cut to 80 characters")
	func taskIsBounded() {
		let info = SessionActivityInfo(
			agentID: "a", agentName: "Forge", task: String(repeating: "y", count: 500))
		#expect(info.task.count == 80)
	}

	@Test("state and info round-trip and stay far under ActivityKit's 4 KB limit")
	func payloadFits() throws {
		let state = SessionActivityState(phase: .needsYou, step: "Waiting on your call")
		let info = SessionActivityInfo(
			agentID: UUID().uuidString, agentName: String(repeating: "n", count: 80),
			task: String(repeating: "t", count: 80))
		let encoded = try JSONEncoder().encode(state)
		#expect(try JSONDecoder().decode(SessionActivityState.self, from: encoded) == state)
		#expect(encoded.count + (try JSONEncoder().encode(info)).count < 1024)
	}
}
