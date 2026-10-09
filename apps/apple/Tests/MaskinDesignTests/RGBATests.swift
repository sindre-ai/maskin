import Testing

@testable import MaskinDesign

@Suite("RGBA")
struct RGBATests {
	@Test("decodes a hex literal into channels")
	func hex() {
		#expect(RGBA(0x4F46E5) == RGBA(red: 79, green: 70, blue: 229))
	}

	@Test("generated tokens map onto the Patina brand")
	func accentTokenExists() {
		// Compiles only if the generator emitted `accent`; the value itself is
		// pinned by the gen-tokens --check drift gate, not re-asserted here.
		_ = MaskinColor.accent
		#expect(MaskinRadius.card == 12)
		#expect(MaskinDuration.d150 == 0.15)
	}
}
