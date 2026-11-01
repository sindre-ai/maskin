import Testing

@testable import MaskinFeatures

@Suite("Linked chip tap")
struct LinkedChipTapTests {
	@Test("a tap on a chip opens the link straight away; it does not rise the preview sheet")
	func tapOpensStraightAway() {
		#expect(LinkedChipSheet.tapShowsSheet == false)
	}
}
