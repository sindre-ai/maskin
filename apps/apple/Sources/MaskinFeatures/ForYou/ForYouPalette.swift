import MaskinDesign
import SwiftUI

/// Receipt / waiting / failure tints that the design tokens don't carry in a dark-aware form
/// (`MaskinColor.successTint` is the same light green in both modes). Values come from the
/// iPhone mockup's `--green*` variables, with dark counterparts chosen to keep the same contrast.
enum ForYouPalette {
	static let receiptBackground = Color(light: RGBA(0xF0FDF4), dark: RGBA(0x0F2A1B))
	static let receiptBorder = Color(light: RGBA(0xBBF7D0), dark: RGBA(0x1F5135))
	static let receiptForeground = Color(light: RGBA(0x15803D), dark: RGBA(0x86EFAC))
	static let receiptSecondary = Color(light: RGBA(0x166534), dark: RGBA(0xBBF7D0))
	static let receiptTertiary = Color(light: RGBA(0x4D7C5F), dark: RGBA(0x6EBF8E))
	static let receiptCheck = Color(light: RGBA(0x16A34A), dark: RGBA(0x22C55E))

	static let waitingBackground = Color(light: RGBA(0xECFDF5), dark: RGBA(0x0F2A27))
	static let waitingForeground = Color(light: RGBA(0x0F766E), dark: RGBA(0x5EEAD4))

	static let failureBackground = Color(light: RGBA(0xFEF2F2), dark: RGBA(0x2D1416))
	static let failureBorder = Color(light: RGBA(0xFECACA), dark: RGBA(0x5C2326))
	static let failureForeground = Color(light: RGBA(0xB91C1C), dark: RGBA(0xFCA5A5))

	static let heldNote = Color(light: RGBA(0xB45309), dark: RGBA(0xFBBF24))

}
