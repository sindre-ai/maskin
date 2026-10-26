import MaskinDesign
import MaskinUI
import SwiftUI

/// The frame and buttons the agent-request cards share (Connect, Computer, integration access),
/// in the look of the question card.
extension View {
	func requestCardFrame() -> some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
		return padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: shape)
			.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.padding(.top, MaskinSpace.s3)
			.accessibilityElement(children: .contain)
	}
}

/// A full-width capsule button: filled when primary, outlined otherwise.
struct RequestCardButton: View {
	let title: String
	var primary = false
	var disabled = false
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.light)
			action()
		} label: {
			Text(title)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(primary ? MaskinSurface.onInverse : MaskinColor.ink)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				.background {
					if primary {
						Capsule().fill(MaskinSurface.inverse)
					} else {
						Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1)
					}
				}
				.opacity(disabled ? 0.35 : 1)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(disabled)
	}
}

/// What a card shows once it has been answered: an icon and one line.
struct RequestCardSettled: View {
	let symbol: String
	let text: String

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
			Image(systemName: symbol).foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
			Text(text).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
		}
		.accessibilityElement(children: .combine)
	}
}
