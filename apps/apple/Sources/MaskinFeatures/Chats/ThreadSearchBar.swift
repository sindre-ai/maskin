import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Search in chat (spec 7 §4). Replaces the composer: `[🔍] [Search this chat] [n of m] [↑ older]
/// [↓ newer] [Done]` with 40pt buttons. Typing jumps to the newest match; Return steps to older
/// ones. Matches are ordered oldest first, so "older" is a step of −1.
struct ThreadSearchBar: View {
	@Binding var text: String
	let matchCount: Int
	/// Zero-based index of the highlighted match.
	let index: Int?
	let onStep: (Int) -> Void
	let onClose: () -> Void
	@FocusState private var focused: Bool

	static let buttonSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s4

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			Image(systemName: "magnifyingglass")
				.font(.system(size: MaskinFontSize.t15, weight: .semibold))
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: Self.buttonSize, height: Self.buttonSize)
				.accessibilityHidden(true)
			TextField("Search this chat", text: $text)
				.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
				.foregroundStyle(MaskinColor.ink)
				.focused($focused)
				.submitLabel(.search)
				.onSubmit { onStep(-1) }  // Return steps to the next older match
				.autocorrectionDisabled()
				.frame(minHeight: Self.buttonSize)
			if !text.isEmpty {
				Text(summary)
					.font(MaskinTypeface.mono(MaskinFontSize.t12, relativeTo: .caption))
					.foregroundStyle(MaskinColor.ink4).monospacedDigit().lineLimit(1)
					.accessibilityLabel(matchCount == 0 ? "No matches" : "Match \((index ?? 0) + 1) of \(matchCount)")
			}
			stepButton("chevron.up", label: "Older match") { onStep(-1) }
			stepButton("chevron.down", label: "Newer match") { onStep(1) }
			Button(action: onClose) {
				Text("Done")
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink)
					.padding(.horizontal, MaskinSpace.s5)
					.frame(minHeight: Self.buttonSize)
					.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.frame(minHeight: MaskinSpace.touchMin)
		}
		.padding(.horizontal, MaskinSpace.s3)
		.padding(.vertical, MaskinSpace.s3)
		.maskinGlass(in: RoundedRectangle(cornerRadius: MaskinRadius.composer, style: .continuous))
		.onAppear { focused = true }
		.accessibilityElement(children: .contain)
	}

	private var summary: String {
		matchCount == 0 ? "0 of 0" : "\((index ?? 0) + 1) of \(matchCount)"
	}

	private func stepButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Image(systemName: symbol).font(.system(size: MaskinFontSize.t15, weight: .semibold))
				.frame(width: Self.buttonSize, height: Self.buttonSize)
				.background(MaskinSurface.fill, in: Circle())
				.contentShape(Circle())
		}
		.buttonStyle(.maskinPressed)
		.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
		.foregroundStyle(matchCount == 0 ? MaskinColor.ink5 : MaskinColor.ink2)
		.disabled(matchCount == 0)
		.accessibilityLabel(label)
	}
}
