import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The message a draft answers, above the draft text, so a reply is read in context. Read only and
/// not part of what Approve is bound to. Cut after five lines with Show more / Show less, as the web
/// does; the toggle only appears when the text is actually cut. The same block sits on the For You
/// card and on the chat card.
struct OriginalMessageView: View {
	let label: String
	let text: String
	/// Lines shown before the rest is folded away.
	static let collapsedLines = 5

	@State private var expanded = false
	@State private var fullHeight: CGFloat = 0
	@State private var cutHeight: CGFloat = 0
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// `cutHeight` only follows the text while it is cut, so it keeps the cut height once opened and
	/// the toggle stays to close it again.
	private var isCut: Bool { fullHeight > cutHeight + 1 }

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
				.fill(MaskinColor.sigHi).frame(width: MaskinSpace.s1 + 1)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(label)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold))
					.foregroundStyle(MaskinColor.ink4)
					.accessibilityHidden(true)
				quote
				if isCut { toggle }
			}
		}
		.fixedSize(horizontal: false, vertical: true)
		.accessibilityElement(children: .contain)
	}

	private var quote: some View {
		Text(text)
			.font(MaskinTypeface.sans(MaskinFontSize.t14))
			.foregroundStyle(MaskinColor.ink3)
			.lineLimit(expanded ? nil : Self.collapsedLines)
			.multilineTextAlignment(.leading)
			.frame(maxWidth: .infinity, alignment: .leading)
			.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { if !expanded { cutHeight = $0 } }
			.background(alignment: .top) {
				// A hidden copy with no limit: its height says whether the shown text was cut.
				Text(text)
					.font(MaskinTypeface.sans(MaskinFontSize.t14))
					.fixedSize(horizontal: false, vertical: true)
					.frame(maxWidth: .infinity, alignment: .leading)
					.hidden()
					.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { fullHeight = $0 }
			}
			.accessibilityLabel("\(label): \(text)")
	}

	private var toggle: some View {
		Button {
			MaskinHaptics.play(.light)
			if reduceMotion { expanded.toggle() } else { withAnimation(MaskinMotion.standard) { expanded.toggle() } }
		} label: {
			Text(expanded ? "Show less" : "Show more")
				.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold))
				.foregroundStyle(MaskinColor.ink4)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(expanded ? "Show less of the message this answers" : "Show more of the message this answers")
	}
}
