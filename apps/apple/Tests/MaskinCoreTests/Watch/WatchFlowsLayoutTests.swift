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

	@Test("the daily card comes first, then flows that need the wearer, each group A to Z")
	func tiles() {
		let flows = [flow("Sales", needsYou: false), flow("SEO", needsYou: true), flow("Delivery", needsYou: true), flow("Admin", needsYou: false)]
		let tiles = WatchFlowsLayout.tiles(flows: flows, needsCount: 3)
		#expect(tiles.map(\.id) == ["daily", "Delivery", "SEO", "Admin", "Sales"])
		#expect(tiles[0].isDaily)
		#expect(tiles[0].big == "3")
		#expect(tiles[0].caption == "decisions need you")
		#expect(tiles[1].tag == "FLOW \u{00B7} DELIVERY")
		#expect(tiles[1].flowID == "Delivery")
	}

	@Test("the daily card is singular for one decision")
	func dailySingular() {
		#expect(WatchFlowsLayout.tiles(flows: [], needsCount: 1)[0].caption == "decision needs you")
	}

	@Test("a card from an older snapshot falls back to the progress")
	func tileFallback() {
		let tile = WatchFlowsLayout.tiles(flows: [flow("A", needsYou: false)], needsCount: 0)[1]
		#expect(tile.big == "50%")
		#expect(tile.caption == "of the cycle done")
	}

	@Test("a flow counts its waiting decisions, else its first target, else its progress")
	func figure() {
		let target = (actual: "0", goal: "10", label: "Paying")
		#expect(WatchFlowsLayout.figure(waiting: 1, target: target, progress: 0.2) == ("1", "decision waits"))
		#expect(WatchFlowsLayout.figure(waiting: 5, target: nil, progress: 0.2) == ("5", "decisions wait"))
		#expect(WatchFlowsLayout.figure(waiting: 0, target: target, progress: 0.2) == ("0 of 10", "paying"))
		#expect(WatchFlowsLayout.figure(waiting: 0, target: nil, progress: 0.62) == ("62%", "of the cycle done"))
	}

	@Test("paging wraps at both ends")
	func wrapped() {
		#expect(WatchFlowsLayout.wrapped(0, by: -1, count: 4) == 3)
		#expect(WatchFlowsLayout.wrapped(3, by: 1, count: 4) == 0)
		#expect(WatchFlowsLayout.wrapped(1, by: 1, count: 4) == 2)
		#expect(WatchFlowsLayout.wrapped(0, by: 1, count: 0) == 0)
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
