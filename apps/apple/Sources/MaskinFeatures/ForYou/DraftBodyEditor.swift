import MaskinDesign
import SwiftUI

/// The text of a draft as an editable field that grows with what is typed, never scrolling on its
/// own. One editor for the For you card and the chat card, so a draft reads and edits the same in
/// both.
struct DraftBodyEditor: View {
	@Binding var text: String
	let isEnabled: Bool
	let accessibilityLabel: String

	private var font: Font { MaskinTypeface.sans(MaskinFontSize.t15) }

	var body: some View {
		ZStack(alignment: .topLeading) {
			// An invisible copy of the text gives the editor its height: it grows with what is typed.
			Text(text + "\n")
				.font(font).lineSpacing(MaskinSpace.s2)
				.opacity(0)
				.padding(.horizontal, MaskinSpace.s2 + MaskinSpace.s1)
				.padding(.vertical, MaskinSpace.s4)
				.frame(maxWidth: .infinity, alignment: .leading)
				.accessibilityHidden(true)
			TextEditor(text: $text)
				.font(font).lineSpacing(MaskinSpace.s2)
				.foregroundStyle(MaskinColor.ink)
				.scrollContentBackground(.hidden)
				.scrollDisabled(true)
				.disabled(!isEnabled)
				.accessibilityLabel(accessibilityLabel)
				.accessibilityHint("Double tap to edit")
		}
		.frame(minHeight: MaskinSpace.touchMin * 3)
	}
}
