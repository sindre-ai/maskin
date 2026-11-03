import SwiftUI

/// v19 palette (bg #FBFCFE / #0F1215, soft, line, ink as the action surface). iOS-only surface and chrome colours: the grouped-list look (grey canvas, white
/// cards) the iPhone mockup uses. These are additions to the web tokens, hand-written
/// because the web app has no grouped background; values come from the mockup's
/// `--bg/--card/--sep/--line/--tint/--amber*` variables, with the mockup's dark values.
public enum MaskinSurface {
	/// Screen canvas behind grouped cards (`--bg`).
	public static let grouped = Color(light: RGBA(0xFBFCFE), dark: RGBA(0x0F1215))
	/// Primary card on the canvas (`--card`).
	public static let card = Color(light: RGBA(0xFFFFFF), dark: RGBA(0x181C21))
	/// Inset well inside a card (`--card2`).
	public static let cardInset = Color(light: RGBA(0xFDFEFF), dark: RGBA(0x1D2227))
	/// Deeper inset, e.g. a held-note block (`--card3`).
	public static let cardInset2 = Color(light: RGBA(0xEDF1F8), dark: RGBA(0x1F252B))
	/// Hairline between rows inside a card (`--sep`).
	public static let separator = Color(light: RGBA(0xE8EDF5), dark: RGBA(0x1D2126))
	/// Card / control border (`--line`).
	public static let line = Color(light: RGBA(0xE1E7F0), dark: RGBA(0x262B31))
	/// Quiet fill for icon buttons and search fields (`--tint2`).
	public static let fill = Color(
		light: RGBA(red: 14, green: 20, blue: 34, alpha: 0.06),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.08))
	/// Pressed / selected fill (`--tint3`).
	public static let fillStrong = Color(
		light: RGBA(red: 14, green: 20, blue: 34, alpha: 0.08),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.12))
	/// Inverted primary-action surface (`--inv`) and its label (`--invFg`).
	public static let inverse = Color(light: RGBA(0x0E1422), dark: RGBA(0xE9ECEF))
	public static let onInverse = Color(light: RGBA(0xFFFFFF), dark: RGBA(0x0F1215))
	/// Fallback fill for glass surfaces where `glassEffect` is unavailable (`--glass`).
	public static let glassFallback = Color(
		light: RGBA(red: 255, green: 255, blue: 255, alpha: 0.6),
		dark: RGBA(red: 28, green: 33, blue: 39, alpha: 0.62))
	/// Glass edge highlight (`--glassBd`).
	public static let glassBorder = Color(
		light: RGBA(red: 255, green: 255, blue: 255, alpha: 0.7),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.08))
}
