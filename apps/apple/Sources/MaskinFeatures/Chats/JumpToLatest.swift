import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §4: a 44pt glass circle with ↓, shown when the reader is more than 420pt from the bottom,
/// with a 20pt badge counting the messages that arrived since they scrolled away. It sits in the
/// composer stack (right-aligned, 10pt above the composer) so it rides up as the composer grows.
struct JumpToLatest: View {
	let unseen: Int
	let action: () -> Void

	/// How far from the bottom (in points) the thread must be scrolled before the button shows,
	/// and the limit within which new messages still auto-scroll.
	static let showAfterDistance: CGFloat = 420

	var body: some View {
		Button(action: action) {
			Image(systemName: "arrow.down")
				.font(.system(size: MaskinFontSize.t16, weight: .semibold))
				.foregroundStyle(MaskinColor.ink)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.maskinGlass(in: Circle(), interactive: true)
				.overlay(alignment: .topTrailing) {
					if unseen > 0 {
						Text(unseen > 99 ? "99+" : "\(unseen)")
							.font(MaskinTypeface.sans(MaskinFontSize.t11, weight: .bold, relativeTo: .caption2))
							.foregroundStyle(MaskinColor.badgeFg)
							.padding(.horizontal, MaskinSpace.s3)
							.frame(minWidth: MaskinSpace.s11, minHeight: MaskinSpace.s11)
							.background(MaskinGradient.badgeSolid, in: Capsule())
							.offset(x: MaskinSpace.s2, y: -MaskinSpace.s2)
							.transition(.scale.combined(with: .opacity))
					}
				}
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(Self.accessibilityLabel(unseen: unseen))
	}

	static func accessibilityLabel(unseen: Int) -> String {
		switch unseen {
		case 0: "Jump to latest"
		case 1: "Jump to latest, 1 new message"
		default: "Jump to latest, \(unseen) new messages"
		}
	}
}
