import SwiftUI

/// Syntax colours for code blocks. Hand-written beside the generated tokens, with a light and a
/// dark value each, picked to read on the code surface (`MaskinSurface.cardInset2`) in both modes.
public enum MaskinCode {
	public static let keyword = Color(light: RGBA(0x7C3AED), dark: RGBA(0xC4B5FD))
	public static let string = Color(light: RGBA(0x0F766E), dark: RGBA(0x5EEAD4))
	public static let number = Color(light: RGBA(0xB45309), dark: RGBA(0xFCD34D))
	public static let type = Color(light: RGBA(0x1D4ED8), dark: RGBA(0x93C5FD))
	public static let literal = Color(light: RGBA(0xBE185D), dark: RGBA(0xF9A8D4))
	public static let property = Color(light: RGBA(0x0369A1), dark: RGBA(0x7DD3FC))
}
