import SwiftUI

/// An sRGB color with 0–255 channels, the shape the generated tokens use.
public struct RGBA: Sendable, Hashable {
	public var red: Int
	public var green: Int
	public var blue: Int
	public var alpha: Double

	public init(red: Int, green: Int, blue: Int, alpha: Double = 1) {
		self.red = red
		self.green = green
		self.blue = blue
		self.alpha = alpha
	}

	/// `RGBA(0x4F46E5)`
	public init(_ hex: UInt32) {
		self.init(
			red: Int((hex >> 16) & 0xFF),
			green: Int((hex >> 8) & 0xFF),
			blue: Int(hex & 0xFF)
		)
	}
}

extension Color {
	/// A color that follows the system appearance, so views never branch on
	/// `colorScheme` for tokens. watchOS has no light mode, so it takes `dark`.
	public init(light: RGBA, dark: RGBA) {
		#if canImport(UIKit) && !os(watchOS)
		self.init(
			uiColor: UIColor { traits in
				let c = traits.userInterfaceStyle == .dark ? dark : light
				return UIColor(
					red: CGFloat(c.red) / 255, green: CGFloat(c.green) / 255,
					blue: CGFloat(c.blue) / 255, alpha: c.alpha)
			})
		#elseif canImport(AppKit)
		self.init(
			nsColor: NSColor(name: nil) { appearance in
				let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
				let c = isDark ? dark : light
				return NSColor(
					srgbRed: CGFloat(c.red) / 255, green: CGFloat(c.green) / 255,
					blue: CGFloat(c.blue) / 255, alpha: c.alpha)
			})
		#else
		self.init(
			.sRGB, red: Double(dark.red) / 255, green: Double(dark.green) / 255,
			blue: Double(dark.blue) / 255, opacity: dark.alpha)
		#endif
	}
}
