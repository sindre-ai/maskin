import MaskinDesign
import SwiftUI

/// Receipt / waiting / failure treatments for the feed. Done is neutral ink on the neutral done tint
/// (Patina is never read as "done"); waiting is a Patina signal; failure keeps red.
enum ForYouPalette {
	static let receiptBackground = MaskinColor.doneBg
	static let receiptBorder = MaskinColor.doneBd
	static let receiptForeground = MaskinColor.doneFg
	static let receiptSecondary = MaskinColor.doneFg2
	static let receiptTertiary = MaskinColor.doneFg3
	static let receiptCheck = MaskinColor.doneFg

	static let waitingBackground = MaskinColor.sigTint
	static let waitingForeground = MaskinColor.sigInk

	static let failureBackground = Color(light: RGBA(0xFEF2F2), dark: RGBA(0x2D1416))
	static let failureBorder = Color(light: RGBA(0xFECACA), dark: RGBA(0x5C2326))
	static let failureForeground = Color(light: RGBA(0xB91C1C), dark: RGBA(0xFCA5A5))

	/// "held 2d": a signal, so Patina ink rather than amber.
	static let heldNote = MaskinColor.sigInk
}
