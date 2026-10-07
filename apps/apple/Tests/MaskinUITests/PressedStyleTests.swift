import Testing

@testable import MaskinUI

@Suite("Pressed style") struct PressedStyleTests {
	@Test func restingIsUntouchedForEveryKind() {
		for kind in MaskinPressKind.allCases {
			let look = kind.appearance(isPressed: false, reduceMotion: false)
			#expect(look.opacity == 1 && look.scale == 1)
		}
	}

	@Test func dimPressesToPointFiveFive() {
		let look = MaskinPressKind.dim.appearance(isPressed: true, reduceMotion: false)
		#expect(look.opacity == 0.55 && look.scale == 1)
	}

	@Test func shrinkPressesToPointNineSeven() {
		let look = MaskinPressKind.shrink.appearance(isPressed: true, reduceMotion: false)
		#expect(look.opacity == 1 && look.scale == 0.97)
	}

	@Test func reduceMotionNeverScales() {
		for kind in MaskinPressKind.allCases {
			let look = kind.appearance(isPressed: true, reduceMotion: true)
			#expect(look.scale == 1)
			#expect(look.opacity == 0.55)
		}
	}
}
