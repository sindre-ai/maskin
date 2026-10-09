import SwiftUI

extension MaskinSurface {
	/// The solid circle of a top-bar primary action (Live, New). It stays a dark disc in dark mode too
	/// (a touch lighter than the black base so it reads inside the glass capsule); pair with
	/// `onNavInk`.
	public static let navInk = Color(light: RGBA(0x18181B), dark: RGBA(0x232328))
	/// The glyph on `navInk`: white in both modes.
	public static let onNavInk = Color(light: RGBA(0xFFFFFF), dark: RGBA(0xFAFAFA))
}
