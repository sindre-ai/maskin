import Testing

@testable import MaskinCore

@Suite("Watch flows layout")
struct WatchFlowsLayoutTests {
	private func flow(_ name: String, needsYou: Bool) -> WatchSnapshot.Flow {
		WatchSnapshot.Flow(
			id: name, name: name, progress: 0.5, paused: false, needsYou: needsYou, cycleStage: "Cycle 1")
	}

	@Test("flows that need the wearer come first and the rest fold")
	func split() {
		let flows = [flow("A", needsYou: false), flow("B", needsYou: true), flow("C", needsYou: false)]
		#expect(WatchFlowsLayout.needsYou(flows).map(\.id) == ["B"])
		#expect(WatchFlowsLayout.onTrack(flows).map(\.id) == ["A", "C"])
	}

	@Test("the folded row says more only when other flows are shown above it")
	func label() {
		#expect(WatchFlowsLayout.onTrackLabel(count: 4, othersNeedYou: true) == "4 more on track")
		#expect(WatchFlowsLayout.onTrackLabel(count: 4, othersNeedYou: false) == "4 on track")
	}

	@Test("progress is a whole percent")
	func percent() {
		#expect(WatchFlowsLayout.percent(0.624) == "62%")
		#expect(WatchFlowsLayout.percent(1) == "100%")
	}

	@Test("a waiting flow finds the decision about the same object, ignoring case")
	func waitingCard() {
		let cards: [(id: String, title: String?)] = [("c1", "Other"), ("c2", " outreach  "), ("c3", nil)]
		#expect(WatchFlowsLayout.waitingCard(for: flow("Outreach", needsYou: true), objectTitles: cards) == "c2")
		#expect(WatchFlowsLayout.waitingCard(for: flow("Outreach", needsYou: false), objectTitles: cards) == nil)
		#expect(WatchFlowsLayout.waitingCard(for: flow("Missing", needsYou: true), objectTitles: cards) == nil)
	}
}
