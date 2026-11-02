import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The `/` popover above the composer: items to reference, then the types to create (design 2b).
struct SlashSuggestions: View {
	let items: [SlashItem]
	let isRecent: Bool
	let query: String
	let onPick: (SlashItem) -> Void
	let onCreate: (SlashCreateType) -> Void

	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			ForEach(items) { item in
				row(symbol: "doc.text", title: item.title, subtitle: item.subtitle(isRecent: isRecent)) {
					onPick(item)
				}
				.accessibilityLabel("Link \(item.title), \(item.typeLabel)")
				separator
			}
			ForEach(Array(SlashCreateType.allCases.enumerated()), id: \.element.id) { index, type in
				row(symbol: type.symbol, title: type.label, subtitle: type.summary) { onCreate(type) }
					.accessibilityLabel("Create new \(type.label)")
				if index < SlashCreateType.allCases.count - 1 { separator }
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.shadow(color: MaskinColor.overlayDim.opacity(0.3), radius: MaskinSpace.s8, y: MaskinSpace.s4)
		.accessibilityElement(children: .contain)
	}

	private var separator: some View { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }

	private func row(symbol: String, title: String, subtitle: String, action: @escaping () -> Void) -> some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			HStack(spacing: MaskinSpace.s6) {
				Image(systemName: symbol).foregroundStyle(MaskinColor.ink3)
					.frame(width: MaskinSpace.s13).accessibilityHidden(true)
				VStack(alignment: .leading, spacing: 0) {
					Text(title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink).lineLimit(1)
					Text(subtitle).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
				Spacer(minLength: 0)
			}
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s2)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
	}
}
