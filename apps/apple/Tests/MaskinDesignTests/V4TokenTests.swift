import SwiftUI
import Testing

@testable import MaskinDesign

@Suite("v4 tokens") struct V4TokenTests {
	@Test func noticeAndDoneFamiliesExist() {
		let colors: [Color] = [
			MaskinColor.noticeBg, MaskinColor.noticeBd, MaskinColor.noticeFg, MaskinColor.noticeFg2,
			MaskinColor.noticeFg3, MaskinColor.doneBg, MaskinColor.doneBd, MaskinColor.doneFg,
			MaskinColor.doneFg2, MaskinColor.doneFg3,
		]
		#expect(colors.count == 10)
	}

	@Test func typeScaleHasTheV4Sizes() {
		let sizes: [CGFloat] = [
			MaskinFontSize.t9, MaskinFontSize.t10, MaskinFontSize.t11, MaskinFontSize.t12,
			MaskinFontSize.t13, MaskinFontSize.t14, MaskinFontSize.t15, MaskinFontSize.t16,
			MaskinFontSize.t17, MaskinFontSize.t18, MaskinFontSize.t20, MaskinFontSize.t22,
			MaskinFontSize.t24, MaskinFontSize.t26, MaskinFontSize.t28, MaskinFontSize.t32,
			MaskinFontSize.t34,
		]
		#expect(sizes == [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 32, 34])
	}

	@Test func radiusScaleHasTheV4Steps() {
		let radii: [CGFloat] = [
			MaskinRadius.input, MaskinRadius.btn, MaskinRadius.panel, MaskinRadius.card,
			MaskinRadius.cardXl, MaskinRadius.panelXl, MaskinRadius.hero, MaskinRadius.card2xl,
			MaskinRadius.tile, MaskinRadius.brief, MaskinRadius.composer,
		]
		#expect(radii == [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26])
		#expect(MaskinRadius.pill == 99)
	}

	@Test func oldRadiusNamesAliasTheScale() {
		#expect(MaskinRadiusLarge.card == MaskinRadius.card2xl)
		#expect(MaskinRadiusLarge.tile == MaskinRadius.tile)
	}

	@Test func motionHasTheV4Durations() {
		#expect(MaskinDuration.push == 0.34)
		#expect(MaskinDuration.wave == 0.8)
		#expect(MaskinDuration.waveStagger == 0.12)
		#expect(MaskinDuration.pulse == 1.2)
	}

	@Test func titleRolesFollowV4() {
		#expect(MaskinTextRole.largeTitle.referenceSize == 34)
		#expect(MaskinTextRole.largeTitle.trackingEm == -0.026)
		#expect(MaskinTextRole.largeTitle.lineHeightEm == 1.06)
		#expect(MaskinTextRole.sheetTitle.referenceSize == 24)
		#expect(MaskinTextRole.sheetTitle.trackingEm == -0.022)
	}

	@Test func microLabelsAreMonoTenOrTwelve() {
		#expect(MaskinTextRole.microLabel.referenceSize == 10)
		#expect(MaskinTextRole.microLabelLarge.referenceSize == 12)
		#expect(MaskinTextRole.microLabel.trackingEm == 0.08)
		#expect(MaskinTextRole.microLabelLarge.trackingEm == 0.07)
		#expect(MaskinTextRole.microLabel.isUppercase && MaskinTextRole.microLabelLarge.isUppercase)
		#expect(MaskinTextRole.microLabelMicro.referenceSize == 9 && MaskinTextRole.microLabelMicro.isUppercase)
	}

	@Test func weightScaleMapsOntoPlatformWeights() {
		#expect(MaskinFontWeight.css(MaskinFontWeight.w650) == 600)
		#expect(MaskinFontWeight.css(MaskinFontWeight.w750) == 700)
	}
}
