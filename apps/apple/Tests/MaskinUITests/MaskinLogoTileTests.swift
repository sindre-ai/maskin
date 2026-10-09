import SwiftUI
import Testing

@testable import MaskinUI

@Suite("Maskin logo tile") struct MaskinLogoTileTests {
	@Test func identifiesThePlatformAgentByNameOnly() {
		#expect(isMaskinPlatformAgent(name: "Maskin"))
		#expect(isMaskinPlatformAgent(name: "  maskin "))
		#expect(!isMaskinPlatformAgent(name: "Maskin Bot"))
		#expect(!isMaskinPlatformAgent(name: "Relay"))
	}

	@Test func markFollowsTheHandoffGeometry() {
		let bounds = MaskinMark().path(in: CGRect(x: 0, y: 0, width: 64, height: 64)).boundingRect
		#expect(bounds.minX == 14 && bounds.maxX == 50)
		#expect(bounds.minY == 18 && bounds.maxY == 54)
	}

	@Test func sizesFollowTheHandoffTable() {
		#expect(MaskinLogoTile.cornerRadius(for: 62) == 16 || MaskinLogoTile.cornerRadius(for: 62) == 15)
		#expect(MaskinLogoTile.cornerRadius(for: 30) == 8 || MaskinLogoTile.cornerRadius(for: 30) == 9)
		#expect(MaskinLogoTile.markFraction(for: 18) == 0.62)
		#expect(MaskinLogoTile.markFraction(for: 30) == 0.58)
	}
}
