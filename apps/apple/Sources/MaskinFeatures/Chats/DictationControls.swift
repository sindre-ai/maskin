import MaskinDesign
import MaskinUI
import SwiftUI

/// The recording state's two buttons, shared by the chat composer and the new-conversation sheet:
/// Discard (puts back the text from before the mic opened) and Done (keeps the text).
struct DictationDiscardButton: View {
	var size: CGFloat = MaskinSpace.touchMin - MaskinSpace.s2
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			Image(systemName: "xmark")
				.maskinSymbol(MaskinFontSize.t15, weight: .semibold)
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: size, height: size)
				.background(MaskinSurface.fill, in: Circle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("Discard dictation")
	}
}

struct DictationDoneButton: View {
	var size: CGFloat = MaskinSpace.touchMin - MaskinSpace.s2
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			Image(systemName: "checkmark")
				.maskinSymbol(MaskinFontSize.t15, weight: .bold)
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: size, height: size)
				.background(MaskinSurface.inverse, in: Circle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("Done dictating")
	}
}
