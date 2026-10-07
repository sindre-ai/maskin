import MaskinDesign
import MaskinUI
import SwiftUI

/// The recording state's two buttons, shared by the chat composer and the new-conversation sheet:
/// Discard (puts back the text from before the mic opened) and Done (keeps the text).
struct DictationDiscardButton: View {
	var size: CGFloat = MaskinSpace.s14 + MaskinSpace.s3
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			Image(systemName: "xmark")
				.font(.system(size: MaskinFontSize.t15, weight: .semibold))
				.foregroundStyle(MaskinColor.ink2)
				.frame(width: size, height: size)
				.background(MaskinSurface.fill, in: Circle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Discard dictation")
	}
}

struct DictationDoneButton: View {
	var size: CGFloat = MaskinSpace.s14 + MaskinSpace.s3
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			Image(systemName: "checkmark")
				.font(.system(size: MaskinFontSize.t15, weight: .bold))
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: size, height: size)
				.background(MaskinSurface.inverse, in: Circle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Done dictating")
	}
}
