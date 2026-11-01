import Testing

@testable import MaskinDesign

@Suite("Call orb style") struct CallOrbStyleTests {
	@Test func everyToneHasAGradientOfTwoStops() {
		for tone in [CallOrbStyle.Tone.live, .calm, .muted] {
			#expect(CallOrbStyle(tone).gradientColors.count == 2)
		}
	}

	@Test func mutedIsDimmedAndHasNoGlow() {
		#expect(CallOrbStyle(.muted).opacity < 1)
		#expect(CallOrbStyle(.live).opacity == 1)
		#expect(CallOrbStyle(.muted).glow != CallOrbStyle(.live).glow)
	}
}
