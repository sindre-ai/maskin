import SwiftUI
import Testing

@testable import MaskinDesign

@Suite("Patina tokens")
struct PatinaTests {
	@Test("a 150deg CSS gradient runs top-leading toward bottom-trailing")
	func angleMapsToUnitPoints() {
		let p = MaskinGradient.points(angle: 150)
		#expect(abs(p.start.x - 0.25) < 0.001)
		#expect(abs(p.end.y - 0.933) < 0.001)
	}

	@Test("0deg runs bottom to top and 180deg top to bottom")
	func cardinalAngles() {
		let up = MaskinGradient.points(angle: 0)
		#expect(up.start.y > up.end.y)
		let down = MaskinGradient.points(angle: 180)
		#expect(down.start.y < down.end.y)
	}

	@Test("the ambient wash has the prototype's three layers, bottom behind the tab bar")
	func ambientLayers() {
		#expect(AmbientBackground.topLeading.centerX == 0.12)
		#expect(AmbientBackground.topLeading.radiusY == 0.34)
		#expect(AmbientBackground.topTrailing.centerX == 1)
		#expect(AmbientBackground.bottom.centerY > 1)
		#expect(AmbientBackground.bottom.radiusY < AmbientBackground.topLeading.radiusY)
	}
}
