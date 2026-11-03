import MaskinDesign
import SwiftUI

/// The colours of the full-screen brief viewer. The viewer sits on a fixed cobalt backdrop
/// (`MaskinGradient.briefViewer`) that is dark in both appearances, so its white ink and white
/// translucent fills are deliberately NOT adaptive tokens: an adaptive "ink" would flip to dark
/// text in light mode. They live here, once, so a palette change touches one file.
enum BriefViewerPalette {
	/// Text and icons on the backdrop.
	static let ink = Color(white: 1)
	/// Secondary text on the backdrop.
	static let inkSoft = MaskinColor.patina100.opacity(0.7)
	static let inkFaint = MaskinColor.patina100.opacity(0.6)
	static let placeholder = ink.opacity(0.5)
	/// Chips, round buttons and the close button.
	static let fill = ink.opacity(0.16)
	/// Cards and the composer field.
	static let fillSoft = ink.opacity(0.1)
	static let fillStrong = ink.opacity(0.3)
	static let fillDisabled = ink.opacity(0.14)
	static let stroke = ink.opacity(0.18)
	/// The unfilled progress segments.
	static let track = ink.opacity(0.25)
	/// The follow-up panel's well.
	static let panel = Color(white: 0).opacity(0.28)
	/// The reader's own bubble: white with navy text, the "on accent" pairing.
	static let bubbleMine = ink.opacity(0.92)
	static let bubbleMineText = MaskinColor.onAccent
}
