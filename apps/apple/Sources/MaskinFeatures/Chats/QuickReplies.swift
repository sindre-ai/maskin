import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §5b: one-tap answers in the composer stack, right-aligned. 40pt pills, `card` fill, 1pt
/// `line` border, 14pt semibold. The rules that pick them are `QuickReplyRules` in Core; this only
/// draws what it is given and sends on tap.
struct QuickReplyChips: View {
	let replies: [String]
	let onPick: (String) -> Void

	static let height: CGFloat = MaskinSpace.s14 + MaskinSpace.s4

	var body: some View {
		if !replies.isEmpty {
			ScrollView(.horizontal) {
				HStack(spacing: MaskinSpace.s4) {
					ForEach(replies, id: \.self) { reply in
						Button {
							MaskinHaptics.play(.light)
							onPick(reply)
						} label: {
							Text(reply)
								.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
								.foregroundStyle(MaskinColor.ink)
								.lineLimit(1)
								.padding(.horizontal, MaskinSpace.s9)
								.frame(height: Self.height)
								.background(MaskinSurface.card, in: Capsule())
								.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
								.contentShape(Capsule())
						}
						.buttonStyle(.maskinPressed)
						.frame(minHeight: MaskinSpace.touchMin)
					}
				}
				.frame(maxWidth: .infinity, alignment: .trailing)
			}
			.scrollIndicators(.hidden)
			.defaultScrollAnchor(.trailing)
			.scrollClipDisabled()
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Quick replies")
		}
	}
}
