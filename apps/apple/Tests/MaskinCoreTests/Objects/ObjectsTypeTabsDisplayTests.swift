import Foundation
import Testing

@testable import MaskinCore

@Suite("Items type tabs display option")
struct ObjectsTypeTabsDisplayTests {
	@Test func tabsAreOffByDefault() {
		let display = ObjectsDisplay()
		#expect(!display.showsTypeTabs)
		#expect(!display.isCustomised)
	}

	@Test func turningTabsOnCountsAsCustomised() {
		#expect(ObjectsDisplay(showsTypeTabs: true).isCustomised)
	}

	@Test func choicesSavedBeforeTheOptionExistedDecodeWithTabsOff() throws {
		let old = Data(#"{"sort":"updated","reversed":false,"needsYouOnly":false}"#.utf8)
		let display = try JSONDecoder().decode(ObjectsDisplay.self, from: old)
		#expect(!display.showsTypeTabs)
		#expect(display.sort == .updated)
	}

	@Test func theChoiceSurvivesARoundTrip() throws {
		let data = try JSONEncoder().encode(ObjectsDisplay(showsTypeTabs: true))
		#expect(try JSONDecoder().decode(ObjectsDisplay.self, from: data).showsTypeTabs)
	}
}
