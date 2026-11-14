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
				== ["Overview", "Performance", "Items", "Room", "Setup"])
	}

	@Test("each view is a tab after the fixed tabs, in order")
	func order() {
		#expect(
			LoopDetailTab.tabs(views: [results, health], hasBriefings: false).map(\.title)
				== ["Overview", "Performance", "Items", "Room", "Setup", "Results", "Pipeline health"])
	}

	@Test("Briefings joins after Performance once the flow has one")
	func briefings() {
		#expect(
			LoopDetailTab.tabs(views: [results], hasBriefings: true).map(\.title)
				== ["Overview", "Performance", "Briefings", "Items", "Room", "Setup", "Results"])
	}

	@Test("two views with one name are two tabs")
	func sameName() {
		let twin = LoopView(name: "Results", fileID: "f3")
		let tabs = LoopDetailTab.tabs(views: [results, twin], hasBriefings: false)
		#expect(Set(tabs.map(\.id)).count == tabs.count)
		#expect(tabs[5] != tabs[6])
	}

	@Test("the view tab carries the file it opens")
	func carriesFile() {
		let tab = LoopDetailTab.tabs(views: [results], hasBriefings: false)[5]
		guard case .view(let index, let view) = tab else {
			Issue.record("expected a view tab")
			return
		}
		#expect(index == 0)
		#expect(view == results)
	}
}
