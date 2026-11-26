import MaskinDesign
import MaskinUI
import SwiftUI

/// Sits above the message box while a sent message is held: "Sending…" and Undo, which takes the
/// message back into the box. Same words as the web bar.
struct UndoSendBar: View {
	let onUndo: () -> Void

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s5) {
			Text("Sending…")
				.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, alignment: .leading)
			Button {
				MaskinHaptics.play(.selection)
				onUndo()
			} label: {
				Text("Undo")
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.sigInk)
					.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Undo")
			.accessibilityHint("Takes the message back. Nothing is sent.")
		}
		.padding(.horizontal, MaskinSpace.s5)
		.transition(.opacity.combined(with: .move(edge: .bottom)))
		.accessibilityElement(children: .contain)
	}
}
