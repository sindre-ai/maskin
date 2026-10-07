import MaskinDesign
import SwiftUI

/// Receipt / waiting / failure treatments for the feed. Success is neutral ink on the neutral tint
/// (Patina is never read as "done"); waiting is a Patina signal; failure keeps red.
enum ForYouPalette {
	static let receiptBackground = MaskinColor.successTint
	static let receiptBorder = MaskinColor.successTint2
	static let receiptForeground = MaskinColor.success
	static let receiptSecondary = MaskinColor.successStrong
	static let receiptTertiary = MaskinColor.ink4
	static let receiptCheck = MaskinColor.success

	static let waitingBackground = MaskinColor.sigTint
	static let waitingForeground = MaskinColor.sigInk

	static let failureBackground = Color(light: RGBA(0xFEF2F2), dark: RGBA(0x2D1416))
	static let failureBorder = Color(light: RGBA(0xFECACA), dark: RGBA(0x5C2326))
	static let failureForeground = Color(light: RGBA(0xB91C1C), dark: RGBA(0xFCA5A5))

	static let heldNote = Color(light: RGBA(0xB45309), dark: RGBA(0xFBBF24))

}
