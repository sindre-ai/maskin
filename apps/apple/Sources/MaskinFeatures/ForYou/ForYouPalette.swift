import MaskinDesign
import SwiftUI

/// Receipt / waiting / failure treatments for the feed. Done is neutral ink on the neutral done tint
/// (Patina is never read as "done"); waiting is a Patina signal; failure is a notice.
enum ForYouPalette {
	static let receiptBackground = MaskinColor.doneBg
	static let receiptBorder = MaskinColor.doneBd
	static let receiptForeground = MaskinColor.doneFg
	static let receiptSecondary = MaskinColor.doneFg2
	static let receiptTertiary = MaskinColor.doneFg3
	static let receiptCheck = MaskinColor.doneFg

	static let waitingBackground = MaskinColor.sigTint
	static let waitingForeground = MaskinColor.sigInk

	static let failureBackground = MaskinColor.noticeBg
	static let failureBorder = MaskinColor.noticeBd
	static let failureForeground = MaskinColor.noticeFg

	/// "held 2d": a signal, so Patina ink rather than amber.
	static let heldNote = MaskinColor.sigInk
}
