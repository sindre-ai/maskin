import SwiftUI
import Testing

@testable import MaskinDesign

@Suite("MaskinScaling")
struct DynamicTypeScalingTests {
	@Test("mono labels follow the user up to xxxLarge and stop")
	func monoLabelCeiling() {
		#expect(MaskinScaling.monoLabelSize(.medium) == .medium)
		#expect(MaskinScaling.monoLabelSize(.xxxLarge) == .xxxLarge)
		#expect(MaskinScaling.monoLabelSize(.accessibility1) == .xxxLarge)
		#expect(MaskinScaling.monoLabelSize(.accessibility5) == .xxxLarge)
	}

	@Test("a briefing card is 176 tall and 220 from the first accessibility size")
	func briefingCardHeight() {
		#expect(MaskinScaling.briefingCardHeight(for: .large) == 176)
		#expect(MaskinScaling.briefingCardHeight(for: .xxxLarge) == 176)
		#expect(MaskinScaling.briefingCardHeight(for: .accessibility1) == 220)
		#expect(MaskinScaling.briefingCardHeight(for: .accessibility5) == 220)
	}

	@Test("only the mono label roles are capped")
	func roleCeilings() {
		for role in MaskinTextRole.allCases {
			let capped = role == .microLabel || role == .microLabelLarge
			#expect((role.dynamicTypeCeiling == MaskinScaling.monoLabelCeiling) == capped, "\(role)")
		}
	}
}
