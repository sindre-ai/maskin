import MaskinDesign
import SwiftUI

/// The text of a draft as an editable field that grows with what is typed, never scrolling on its
/// own. One editor for the For you card and the chat card, so a draft reads and edits the same in
/// both.
///
/// A vertical `TextField` sizes itself to its text. The earlier `TextEditor` was sized by an
/// invisible copy of the text stacked under it; inside the chat's bottom-anchored lazy stack that
/// pair kept re-measuring when a card opened, and the screen froze.
struct DraftBodyEditor: View {
	@Binding var text: String
	let isEnabled: Bool
	let accessibilityLabel: String

	private var font: Font { MaskinTypeface.sans(MaskinFontSize.t15) }

	var body: some View {
		TextField(accessibilityLabel, text: $text, axis: .vertical)
			.font(font).lineSpacing(MaskinSpace.s2)
			.foregroundStyle(MaskinColor.ink)
			.lineLimit(1...)
			.disabled(!isEnabled)
			.padding(.horizontal, MaskinSpace.s2 + MaskinSpace.s1)
			.padding(.vertical, MaskinSpace.s4)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin * 3, alignment: .topLeading)
			.accessibilityLabel(accessibilityLabel)
			.accessibilityHint("Double tap to edit")
	}
}
