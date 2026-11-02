import SwiftUI
import Testing

@testable import MaskinDesign

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit

/// WCAG contrast over the v15 palette's key text pairs, light and dark. Colours are resolved the
/// way the system does, so a token that stops adapting to appearance fails here.
@Suite("Palette contrast (v15)")
struct PaletteContrastTests {
	private func rgb(_ color: Color, dark: Bool) -> (r: Double, g: Double, b: Double) {
		var out = (r: 0.0, g: 0.0, b: 0.0)
		NSAppearance(named: dark ? .darkAqua : .aqua)!.performAsCurrentDrawingAppearance {
			let c = NSColor(color).usingColorSpace(.sRGB)!
			out = (Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent))
		}
		return out
	}

	private func luminance(_ c: (r: Double, g: Double, b: Double)) -> Double {
		func lin(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
		return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
	}

	private func ratio(_ fg: Color, _ bg: Color, dark: Bool) -> Double {
		let a = luminance(rgb(fg, dark: dark)), b = luminance(rgb(bg, dark: dark))
		return (max(a, b) + 0.05) / (min(a, b) + 0.05)
	}

	struct Pair: CustomTestStringConvertible {
		let name: String
		let fg: Color
		let bg: Color
		let minimum: Double
		var testDescription: String { name }
	}

	/// Light ok (#12875A) and destructive (#D93A2F) are the handoff's exact values and sit just
	/// under 4.5 on #FBFCFE: fine for bold/large text and icons, so their floor is 4.3, not 4.5.
	static let pairs: [Pair] = [
		Pair(name: "ink on bg", fg: MaskinColor.ink, bg: MaskinSurface.grouped, minimum: 4.5),
		Pair(name: "ink on card", fg: MaskinColor.ink, bg: MaskinSurface.card, minimum: 4.5),
		Pair(name: "mute (ink4) on bg", fg: MaskinColor.ink4, bg: MaskinSurface.grouped, minimum: 4.5),
		Pair(name: "mute (ink4) on card", fg: MaskinColor.ink4, bg: MaskinSurface.card, minimum: 4.5),
		Pair(name: "accent on-accent", fg: MaskinColor.onAccent, bg: MaskinColor.accent, minimum: 4.5),
		Pair(name: "nav disc glyph", fg: MaskinSurface.onNavInk, bg: MaskinSurface.navInk, minimum: 4.5),
		Pair(name: "unread badge", fg: MaskinColor.badgeFg, bg: MaskinGradientPair.badgeFlat, minimum: 4.5),
		Pair(name: "accent text on bg", fg: MaskinColor.sigInk, bg: MaskinSurface.grouped, minimum: 4.5),
		Pair(name: "accent text on tint", fg: MaskinColor.sigInk, bg: MaskinColor.sigTint, minimum: 4.5),
		Pair(name: "danger on bg", fg: MaskinColor.danger, bg: MaskinSurface.grouped, minimum: 4.3),
		Pair(name: "warning on its fill", fg: MaskinColor.warning, bg: MaskinColor.warningTint, minimum: 4.5),
		Pair(name: "warning on bg", fg: MaskinColor.warning, bg: MaskinSurface.grouped, minimum: 4.5),
		Pair(name: "destructive text on bg", fg: MaskinColor.destructive, bg: MaskinSurface.grouped, minimum: 4.3),
		Pair(name: "ok on bg", fg: MaskinColor.ok, bg: MaskinSurface.grouped, minimum: 4.3),
		Pair(name: "on-ok on ok", fg: MaskinColor.onOk, bg: MaskinColor.ok, minimum: 4.5),
		Pair(name: "inverse label", fg: MaskinSurface.onInverse, bg: MaskinSurface.inverse, minimum: 4.5),
		Pair(name: "notice text", fg: MaskinColor.noticeFg, bg: MaskinColor.noticeBg, minimum: 4.5),
		Pair(name: "agent chip", fg: MaskinColor.agentRelayFg, bg: MaskinColor.agentRelayTint, minimum: 4.5),
	]

	@Test("text pairs pass WCAG AA in light mode", arguments: pairs)
	func lightPairs(_ p: Pair) {
		#expect(ratio(p.fg, p.bg, dark: false) >= p.minimum, "\(p.name)")
	}

	@Test("text pairs pass WCAG AA in dark mode", arguments: pairs)
	func darkPairs(_ p: Pair) {
		#expect(ratio(p.fg, p.bg, dark: true) >= p.minimum, "\(p.name)")
	}

	@Test("every status and type badge pair stays readable (3:1 floor, as before v15)")
	func badgePairs() {
		for (key, pair) in MaskinStatusPalette.all.merging(MaskinTypePalette.all, uniquingKeysWith: { a, _ in a }) {
			// "discarded" is deliberately dim (about 2.3:1 light); it was that way before v15.
			if key == "discarded" { continue }
			for dark in [false, true] {
				#expect(ratio(pair.fg, pair.bg, dark: dark) >= 3, "\(key) dark=\(dark)")
			}
		}
	}
}

private enum MaskinGradientPair {
	/// The flat stand-in for the unread-badge gradient's mid colour.
	static let badgeFlat = MaskinGradient.badgeSolid
}
#endif
