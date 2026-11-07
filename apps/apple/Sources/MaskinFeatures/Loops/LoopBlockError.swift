import MaskinDesign
import MaskinUI
import SwiftUI

/// Shown in place of one block of the loop screen when its read failed or got no answer in time.
/// The rest of the screen stays; Try again reads the loop again.
struct LoopBlockError: View {
	let message: String
	var isRetrying = false
	let onRetry: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Text(message).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				.fixedSize(horizontal: false, vertical: true)
			Button("Try again", action: onRetry)
				.buttonStyle(.secondaryAction)
				.disabled(isRetrying)
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("loop-block-error")
	}
}
