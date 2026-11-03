import SwiftUI

extension MaskinSurface {
	/// The solid accent disc of a top-bar primary action (v15: cobalt #1F4FE0, #5B86FF in dark); always
	/// pair with `onNavInk` (white, or #05102B on the dark-mode accent).
	public static let navInk = Color(light: RGBA(0x1F4FE0), dark: RGBA(0x5B86FF))
	/// The glyph on `navInk`.
	public static let onNavInk = Color(light: RGBA(0xFFFFFF), dark: RGBA(0x05102B))
}
