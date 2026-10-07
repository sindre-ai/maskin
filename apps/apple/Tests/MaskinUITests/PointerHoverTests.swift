import Testing

@testable import MaskinUI

@Suite("Pointer hover") struct PointerHoverTests {
	@Test func rowsFillOnHoverAndCardsDoNot() {
		#expect(MaskinHoverKind.fill.showsFill(isHovering: true))
		#expect(!MaskinHoverKind.fill.showsFill(isHovering: false))
		#expect(!MaskinHoverKind.lift.showsFill(isHovering: true))
	}

	@Test func reduceMotionDropsOnlyTheLift() {
		#expect(MaskinHoverKind.lift.systemEffect(reduceMotion: false) == .lift)
		#expect(MaskinHoverKind.lift.systemEffect(reduceMotion: true) == .none)
		#expect(MaskinHoverKind.fill.systemEffect(reduceMotion: true) == .highlight)
	}
}
