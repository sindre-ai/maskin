import Testing

@testable import MaskinCore

@Suite("Watch glance helpers")
struct WatchGlanceTests {
	private func option(_ label: String, recommended: Bool = false) -> DecisionOption {
		DecisionOption(label: label, recommended: recommended)
	}

	@Test("two or fewer options are all shown")
	func fewOptions() {
		let all = [option("Send", recommended: true), option("Hold")]
		#expect(WatchDecisionOptions.visible(all) == all)
	}

	@Test("more than two shows the recommended option first, then one other")
	func manyOptions() {
		let all = [option("A"), option("B"), option("C", recommended: true), option("D")]
		#expect(WatchDecisionOptions.visible(all).map(\.label) == ["C", "A"])
	}

	@Test("with no recommendation the first option leads")
	func noRecommendation() {
		let all = [option("A"), option("B"), option("C")]
		#expect(WatchDecisionOptions.visible(all).map(\.label) == ["A", "B"])
	}

	@Test("markdown becomes plain sentences")
	func plainText() {
		let md = "# Good morning\n\n- **Two** things need [you](https://x.io)\n\n\n\nUse `Hold`."
		#expect(WatchBriefingText.plain(md) == "Good morning\n\nTwo things need you\n\nUse Hold.")
	}

	@Test("paragraphs split on blank lines and drop empties")
	func paragraphs() {
		#expect(WatchBriefingText.paragraphs("One\n\n\nTwo\n\n") == ["One", "Two"])
	}
}
