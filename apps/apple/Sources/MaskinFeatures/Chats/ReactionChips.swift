import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The emoji under a message: one capsule per emoji with its count, filled when you used it.
/// Tapping a capsule adds or takes back your reaction.
struct ReactionChips: View {
	let reactions: [MessageReaction]
	var isOwn = false
	let onToggle: (String) -> Void

	var body: some View {
		if !reactions.isEmpty {
			ChipFlow {
				ForEach(reactions, id: \.emoji) { reaction in
					Button {
						MaskinHaptics.play(.selection)
						onToggle(reaction.emoji)
					} label: {
						HStack(spacing: MaskinSpace.s2) {
							Text(reaction.emoji).font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
							Text("\(reaction.count)")
								.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold, relativeTo: .footnote))
								.foregroundStyle(reaction.reactedByMe ? MaskinColor.sigInk : MaskinColor.ink4)
						}
						.padding(.horizontal, MaskinSpace.s5)
						.frame(height: MaskinSpace.s14)
						.background(reaction.reactedByMe ? MaskinColor.sigHi.opacity(0.35) : MaskinSurface.card, in: Capsule())
						.overlay(
							Capsule().strokeBorder(reaction.reactedByMe ? MaskinColor.sigHi : MaskinSurface.line, lineWidth: 1)
						)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityLabel("\(reaction.emoji), \(reaction.count)")
					.accessibilityHint(reaction.reactedByMe ? "Takes your reaction back" : "Adds your reaction")
					.accessibilityAddTraits(reaction.reactedByMe ? [.isSelected] : [])
				}
			}
			.frame(maxWidth: .infinity, alignment: isOwn ? .trailing : .leading)
		}
	}
}
