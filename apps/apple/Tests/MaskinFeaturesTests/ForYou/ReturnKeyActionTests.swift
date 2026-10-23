import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("DecisionCardView.ReturnKeyAction")
struct ReturnKeyActionTests {
	private func prompt(_ options: [DecisionOption]) -> DecisionPrompt {
		DecisionPrompt(title: "Ship it", summary: "Ready.", ask: "Ship?", options: options)
	}

	@Test func acceptsTheRecommendedOption() {
		let option = DecisionOption(label: "Ship", recommended: true)
		let (action, picked) = DecisionCardView.ReturnKeyAction.resolve(
			for: prompt([DecisionOption(label: "Wait"), option]))
		#expect(action == .choose)
		#expect(picked == option)
	}

	@Test func keepsTheConfirmationForOptionsThatCannotBeUndone() {
		let option = DecisionOption(label: "Send to all", recommended: true, destructive: true)
		let (action, picked) = DecisionCardView.ReturnKeyAction.resolve(for: prompt([option]))
		#expect(action == .confirmFirst)
		#expect(picked == option)
	}

	@Test func asksForAReasonBeforeAHold() {
		let option = DecisionOption(label: "Hold", recommended: true)
		let (action, _) = DecisionCardView.ReturnKeyAction.resolve(for: prompt([option]))
		#expect(action == .askReason)
	}

	@Test func doesNothingWithoutARecommendation() {
		let (action, picked) = DecisionCardView.ReturnKeyAction.resolve(
			for: prompt([DecisionOption(label: "A"), DecisionOption(label: "B")]))
		#expect(action == .nothing)
		#expect(picked == nil)
	}
}
