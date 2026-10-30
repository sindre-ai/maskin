import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The frame every linked card shares: a rounded, outlined card that sits inside a bubble or on
/// the sheet's background.
struct LinkedCardChrome<Content: View>: View {
	@ViewBuilder let content: Content

	var body: some View {
		content
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}
}

/// "EMAIL", "LINKEDIN POST": the kind of thing, in the small mono label the web card uses.
struct LinkedKindChip: View {
	let text: String

	var body: some View {
		Text(text.uppercased())
			.maskinText(.microLabel)
			.tracking(ChatType.mono11Tracking)
			.foregroundStyle(MaskinColor.ink3)
			.lineLimit(1)
			.padding(.horizontal, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s2)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.input, style: .continuous))
	}
}

/// The "Open" control at the head of a card: goes to the object's or file's own screen.
struct LinkedOpenButton: View {
	let target: LinkedTarget
	private let open = LinkedOpener()

	var body: some View {
		Button { open(target) } label: {
			HStack(spacing: MaskinSpace.s1) {
				Text("Open")
				Image(systemName: "arrow.up.right").maskinSymbol(MaskinFontSize.t11, weight: .semibold)
			}
			.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650, relativeTo: .footnote))
			.foregroundStyle(MaskinColor.ink3)
			.frame(minHeight: MaskinSpace.touchMin, alignment: .trailing)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel("Open")
	}
}

/// The collapse chevron, turned over when the card is open.
struct LinkedChevron: View {
	let expanded: Bool

	var body: some View {
		Image(systemName: "chevron.down")
			.maskinSymbol(MaskinFontSize.t12, weight: .semibold)
			.foregroundStyle(MaskinColor.ink5)
			.rotationEffect(.degrees(expanded ? 180 : 0))
			.accessibilityHidden(true)
	}
}

/// A linked file that has no card, or a link that could not be read: the name and what it is, one tap
/// from opening it.
struct LinkedPlainRow: View {
	let target: LinkedTarget
	let title: String
	let kindLabel: String
	var symbol: String = "doc.text"
	private let open = LinkedOpener()

	var body: some View {
		Button { open(target) } label: {
			LinkedCardChrome {
				HStack(spacing: MaskinSpace.s6) {
					Image(systemName: symbol)
						.maskinSymbol(MaskinFontSize.t15, weight: .semibold)
						.foregroundStyle(MaskinColor.ink)
						.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
						.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
						.accessibilityHidden(true)
					VStack(alignment: .leading, spacing: 0) {
						Text(title).maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(MaskinColor.ink).lineLimit(2).multilineTextAlignment(.leading)
						Text(kindLabel).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
					Spacer(minLength: 0)
					Image(systemName: "chevron.right").font(.caption.weight(.semibold))
						.foregroundStyle(MaskinColor.ink5).accessibilityHidden(true)
				}
				.padding(.horizontal, MaskinSpace.s6)
				.padding(.vertical, MaskinSpace.s5)
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("\(title), \(kindLabel)")
		.accessibilityHint("Opens in Maskin")
	}
}
