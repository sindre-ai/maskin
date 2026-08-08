import SwiftUI

/// Port of `tokens/typography.css`. Fixed UI sizes only — the fluid `clamp()` display
/// steps from the marketing site aren't used by the app screens in the design prototype.
///
/// Both families are bundled as variable fonts (`Resources/Fonts/`), registered via
/// `UIAppFonts` in Info.plist. SwiftUI's `.fontWeight()` modifier interpolates along the
/// font's `wght` axis when applied to a `Font.custom`, so a single Regular instance
/// covers every weight the design calls for.
enum MaskinFont {
	private static let displayFamily = "SchibstedGrotesk-Regular"
	private static let monoFamily = "JetBrainsMono-Regular"

	static func display(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
		.custom(displayFamily, size: size).weight(weight)
	}

	static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
		.custom(monoFamily, size: size).weight(weight)
	}

	// MARK: Fixed UI sizes (--fs-* tokens, rem -> pt at 16px base)
	static let micro = display(9.9, weight: .bold) // --fs-micro, badges
	static let label = display(10.9, weight: .bold) // --fs-label, uppercase eyebrows
	static let xs = display(12) // --fs-xs, meta/captions
	static let sm = display(13) // --fs-sm, card body
	static let base = display(14) // --fs-base, nav/links/buttons
	static let md = display(15) // --fs-md, card title/primary button

	// MARK: Tracking (applied via .tracking())
	static let trackingLabel: CGFloat = 1.1 // --ls-label: 0.10em @ 11pt
	static let trackingTight: CGFloat = -0.2 // --ls-tight: -0.02em @ 10pt baseline
}
