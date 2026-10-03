import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Find-in-conversation controls: a field, "2 of 5", previous / next, close. Sits above the composer.
struct ThreadSearchBar: View {
	@Binding var text: String
	let matchCount: Int
	/// Zero-based index of the highlighted match.
	let index: Int?
	let onStep: (Int) -> Void
	let onClose: () -> Void
	@FocusState private var focused: Bool

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			Image(systemName: "magnifyingglass").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
			TextField("Search this chat", text: $text)
				.maskinText(.body)
				.focused($focused)
				.submitLabel(.search)
				.onSubmit { onStep(1) }
				.autocorrectionDisabled()
			if !text.isEmpty {
				Text(summary).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			stepButton("chevron.up", label: "Previous match") { onStep(-1) }
			stepButton("chevron.down", label: "Next match") { onStep(1) }
			Button("Done", action: onClose).maskinText(.subhead)
				.frame(minHeight: MaskinSpace.touchMin)
		}
		.padding(.horizontal, MaskinSpace.s5)
		.maskinGlass(in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.onAppear { focused = true }
	}

	private var summary: String {
		matchCount == 0 ? "No matches" : "\((index ?? 0) + 1) of \(matchCount)"
	}

	private func stepButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Image(systemName: symbol)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.foregroundStyle(matchCount == 0 ? MaskinColor.ink5 : MaskinColor.ink2)
		.disabled(matchCount == 0)
		.accessibilityLabel(label)
	}
}
