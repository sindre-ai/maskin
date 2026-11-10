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
				== ["Overview", "Performance", "Items", "Activity", "Setup"])
	}

	@Test("each view is a tab right after Overview, in order")
	func order() {
		#expect(
			LoopDetailTab.tabs(views: [results, health], hasBriefings: false).map(\.title)
				== ["Overview", "Results", "Pipeline health", "Performance", "Items", "Activity", "Setup"])
	}

	@Test("Briefings joins after Performance once the flow has one")
	func briefings() {
		#expect(
			LoopDetailTab.tabs(views: [results], hasBriefings: true).map(\.title)
				== ["Overview", "Results", "Performance", "Briefings", "Items", "Activity", "Setup"])
	}

	@Test("two views with one name are two tabs")
	func sameName() {
		let twin = LoopView(name: "Results", fileID: "f3")
		let tabs = LoopDetailTab.tabs(views: [results, twin], hasBriefings: false)
		#expect(Set(tabs.map(\.id)).count == tabs.count)
		#expect(tabs[1] != tabs[2])
	}

	@Test("the view tab carries the file it opens")
	func carriesFile() {
		let tab = LoopDetailTab.tabs(views: [results], hasBriefings: false)[1]
		guard case .view(let index, let view) = tab else {
			Issue.record("expected a view tab")
			return
		}
		#expect(index == 0)
		#expect(view == results)
	}
}
