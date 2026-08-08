import SwiftUI
import UIKit

/// Port of `tokens/colors.css` from the Maskin design system. Every token below is a
/// direct copy of the light/dark hex pair defined there — do not round or invent values.
enum MaskinColor {
	private static func dynamic(light: UIColor, dark: UIColor) -> Color {
		Color(UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
	}

	private static func hex(_ hex: UInt32, alpha: CGFloat = 1) -> UIColor {
		UIColor(
			red: CGFloat((hex >> 16) & 0xFF) / 255,
			green: CGFloat((hex >> 8) & 0xFF) / 255,
			blue: CGFloat(hex & 0xFF) / 255,
			alpha: alpha
		)
	}

	// MARK: Ink (foreground ramp)
	static let ink = dynamic(light: hex(0x111110), dark: hex(0xECEAE4))
	static let ink2 = dynamic(light: hex(0x5A5751), dark: hex(0xA09A93))
	static let ink3 = dynamic(light: hex(0x9B958F), dark: hex(0x6B6560))
	static let inkHover = dynamic(light: hex(0x2A2925), dark: hex(0xECEAE4))

	// MARK: Paper (background ramp)
	static let surface = dynamic(light: hex(0xFAFAF8), dark: hex(0x141412))
	static let linen = dynamic(light: hex(0xF0EDE7), dark: hex(0x1C1B18))
	static let rule = dynamic(light: hex(0xE2DDD7), dark: hex(0x2A2925))

	// MARK: Accent
	static let accent = dynamic(light: hex(0x2563EB), dark: hex(0x3B74F2))
	static let accentDim = dynamic(
		light: hex(0x2563EB, alpha: 0.12),
		dark: hex(0x3B74F2, alpha: 0.15)
	)

	// MARK: Object types (Insights -> Bets -> Tasks pipeline)
	static let objInsight = Color(hex(0x5B8DD9))
	static let objBet = Color(hex(0xE67E22))
	static let objTask = Color(hex(0x27AE60))
	static let objKnowledge = Color(hex(0x7C3AED))
	static let objInsightBg = Color(hex(0x5B8DD9, alpha: 0.10))
	static let objBetBg = Color(hex(0xE67E22, alpha: 0.10))
	static let objTaskBg = Color(hex(0x27AE60, alpha: 0.10))
	static let objKnowledgeBg = Color(hex(0x7C3AED, alpha: 0.10))

	// MARK: Semantic
	static let danger = Color(hex(0xE16464))
	static let dangerBg = Color(hex(0xE16464, alpha: 0.06))
	static let success = Color(hex(0x4ADE80))

	static func objectColor(for type: String) -> Color {
		switch type {
		case "insight": return objInsight
		case "bet": return objBet
		case "task": return objTask
		case "loop": return objKnowledge
		default: return ink3
		}
	}
}
