import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("Loop page tabs")
struct LoopDetailTabTests {
	private let results = LoopView(name: "Results", fileID: "f1")
	private let health = LoopView(name: "Pipeline health", fileID: "f2")

	@Test("no views, no extra tab")
	func none() {
		#expect(
			LoopDetailTab.tabs(views: [], hasBriefings: false).map(\.title)
				== ["Overview", "Items", "Activity", "Setup"])
	}

	@Test("each view is a tab ahead of Overview, in order")
	func order() {
		#expect(
			LoopDetailTab.tabs(views: [results, health], hasBriefings: false).map(\.title)
				== ["Results", "Pipeline health", "Overview", "Items", "Activity", "Setup"])
	}

	@Test("Briefings comes first once the flow has one")
	func briefings() {
		#expect(
			LoopDetailTab.tabs(views: [results], hasBriefings: true).map(\.title)
				== ["Briefings", "Results", "Overview", "Items", "Activity", "Setup"])
	}

	@Test("two views with one name are two tabs")
	func sameName() {
		let twin = LoopView(name: "Results", fileID: "f3")
		let tabs = LoopDetailTab.tabs(views: [results, twin], hasBriefings: false)
		#expect(Set(tabs.map(\.id)).count == tabs.count)
		#expect(tabs[0] != tabs[1])
	}

	@Test("the view tab carries the file it opens")
	func carriesFile() {
		let tab = LoopDetailTab.tabs(views: [results], hasBriefings: false)[0]
		guard case .view(let index, let view) = tab else {
			Issue.record("expected a view tab")
			return
		}
		#expect(index == 0)
		#expect(view == results)
	}
}

extension LoopDetailTabTests {
	@Test("the open view stays open when the views list changes, and falls back when it goes")
	func selectionSurvives() {
		let before = LoopDetailTab.tabs(views: [results, health], hasBriefings: false)
		let open = before[1]
		// A briefing joining the bar does not move which tab is open.
		let grown = LoopDetailTab.tabs(views: [results, health], hasBriefings: true)
		#expect(grown.contains(open))
		let gone = LoopDetailTab.tabs(views: [results], hasBriefings: false)
		#expect(!gone.contains(open))
	}
}
