import SwiftUI

/// iOS-only surface and chrome colours: the grouped-list look (grey canvas, white
/// cards) the iPhone mockup uses. These are additions to the web tokens, hand-written
/// because the web app has no grouped background; values come from the mockup's
/// `--bg/--card/--sep/--line/--tint/--amber*` variables, with the mockup's dark values.
public enum MaskinSurface {
	/// Screen canvas behind grouped cards (`--bg`).
	public static let grouped = Color(light: RGBA(0xF4F4F6), dark: RGBA(0x0A0A0C))
	/// Primary card on the canvas (`--card`).
	public static let card = Color(light: RGBA(0xFFFFFF), dark: RGBA(0x17171B))
	/// Inset well inside a card (`--card2`).
	public static let cardInset = Color(light: RGBA(0xFAFAFA), dark: RGBA(0x1D1D22))
	/// Deeper inset, e.g. a held-note block (`--card3`).
	public static let cardInset2 = Color(light: RGBA(0xF6F6F7), dark: RGBA(0x212127))
	/// Hairline between rows inside a card (`--sep`).
	public static let separator = Color(light: RGBA(0xF2F2F4), dark: RGBA(0x26262C))
	/// Card / control border (`--line`).
	public static let line = Color(light: RGBA(0xE9E9EB), dark: RGBA(0x303038))
	/// Quiet fill for icon buttons and search fields (`--tint2`).
	public static let fill = Color(
		light: RGBA(red: 24, green: 24, blue: 27, alpha: 0.06),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.1))
	/// Pressed / selected fill (`--tint3`).
	public static let fillStrong = Color(
		light: RGBA(red: 24, green: 24, blue: 27, alpha: 0.07),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.12))
	/// Inverted primary-action surface (`--inv`) and its label (`--invFg`).
	public static let inverse = Color(light: RGBA(0x18181B), dark: RGBA(0xF2F2F5))
	public static let onInverse = Color(light: RGBA(0xFFFFFF), dark: RGBA(0x101014))
	/// Fallback fill for glass surfaces where `glassEffect` is unavailable (`--glass`).
	public static let glassFallback = Color(
		light: RGBA(red: 255, green: 255, blue: 255, alpha: 0.62),
		dark: RGBA(red: 36, green: 36, blue: 42, alpha: 0.66))
	/// Glass edge highlight (`--glassBd`).
	public static let glassBorder = Color(
		light: RGBA(red: 255, green: 255, blue: 255, alpha: 0.7),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.1))
}
