import SwiftUI

/// iOS-only surface and chrome colours: the grouped-list look (grey canvas, white
/// cards) the iPhone mockup uses. These are additions to the web tokens, hand-written
/// because the web app has no grouped background; values come from the mockup's
/// `--bg/--card/--sep/--line/--tint/--amber*` variables, with the mockup's dark values.
public enum MaskinSurface {
	/// Screen canvas behind grouped cards (`--bg`).
	public static let grouped = Color(light: RGBA(0xF4F4F5), dark: RGBA(0x0A0A0B))
	/// Primary card on the canvas (`--card`).
	public static let card = Color(light: RGBA(0xFFFFFF), dark: RGBA(0x18181B))
	/// Inset well inside a card (`--card2`).
	public static let cardInset = Color(light: RGBA(0xFAFAFA), dark: RGBA(0x1F1F22))
	/// Deeper inset, e.g. a held-note block (`--card3`).
	public static let cardInset2 = Color(light: RGBA(0xF4F4F5), dark: RGBA(0x27272A))
	/// Hairline between rows inside a card (`--sep`).
	public static let separator = Color(light: RGBA(0xF0F0F2), dark: RGBA(0x1F1F22))
	/// Card / control border (`--line`).
	public static let line = Color(light: RGBA(0xECECEE), dark: RGBA(0x27272A))
	/// Quiet fill for icon buttons and search fields (`--tint2`).
	public static let fill = Color(
		light: RGBA(red: 24, green: 24, blue: 27, alpha: 0.06),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.1))
	/// Pressed / selected fill (`--tint3`).
	public static let fillStrong = Color(
		light: RGBA(red: 24, green: 24, blue: 27, alpha: 0.07),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.12))
	/// Inverted primary-action surface (`--inv`) and its label (`--invFg`).
	public static let inverse = Color(light: RGBA(0x18181B), dark: RGBA(0xFAFAFA))
	public static let onInverse = Color(light: RGBA(0xFFFFFF), dark: RGBA(0x0A0A0B))
	/// Fallback fill for glass surfaces where `glassEffect` is unavailable (`--glass`).
	public static let glassFallback = Color(
		light: RGBA(red: 255, green: 255, blue: 255, alpha: 0.62),
		dark: RGBA(red: 39, green: 39, blue: 42, alpha: 0.66))
	/// Glass edge highlight (`--glassBd`).
	public static let glassBorder = Color(
		light: RGBA(red: 255, green: 255, blue: 255, alpha: 0.7),
		dark: RGBA(red: 255, green: 255, blue: 255, alpha: 0.1))
}
