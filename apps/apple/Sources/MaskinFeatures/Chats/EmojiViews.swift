import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The `:query` picker above the composer: the emoji and its name, one per row.
struct EmojiSuggestions: View {
	let items: [(name: String, emoji: String)]
	let onPick: ((name: String, emoji: String)) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			ForEach(items, id: \.name) { item in
				Button {
					MaskinHaptics.play(.selection)
					onPick(item)
				} label: {
					HStack(spacing: MaskinSpace.s6) {
						Text(item.emoji).font(MaskinTypeface.sans(MaskinFontSize.t22, relativeTo: .title2))
						Text(":\(item.name):").maskinText(.body).foregroundStyle(MaskinColor.ink2)
						Spacer(minLength: 0)
					}
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("\(item.name) emoji")
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
	}
}

/// The emoji button's panel: the most-used emoji in a grid.
struct EmojiPickerGrid: View {
	let onPick: (String) -> Void

	var body: some View {
		ScrollView {
			LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: MaskinSpace.s2), count: 6), spacing: MaskinSpace.s2) {
				ForEach(EmojiShortcodes.popular, id: \.self) { emoji in
					Button {
						MaskinHaptics.play(.selection)
						onPick(emoji)
					} label: {
						Text(emoji).font(MaskinTypeface.sans(MaskinFontSize.t22, relativeTo: .title2))
							.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
							.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityLabel(emoji)
				}
			}
			.padding(MaskinSpace.s5)
		}
		.frame(width: 300, height: 260)
	}
}
