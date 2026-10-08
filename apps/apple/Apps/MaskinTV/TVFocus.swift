import MaskinDesign
import SwiftUI

/// The tvOS focus look: scaled up, a 4 pt light ring and a deep shadow, 0.25 s. Reduce Motion drops
/// the scale and keeps the ring. Use it on every focusable control and card.
struct TVFocusStyle: ButtonStyle {
	var scale: CGFloat = 1.04
	var cornerRadius: CGFloat = 32

	func makeBody(configuration: Configuration) -> some View {
		TVFocusBody(configuration: configuration, scale: scale, cornerRadius: cornerRadius)
	}
}

private struct TVFocusBody: View {
	let configuration: ButtonStyleConfiguration
	let scale: CGFloat
	let cornerRadius: CGFloat
	@Environment(\.isFocused) private var isFocused
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		configuration.label
			.scaleEffect(isFocused && !reduceMotion ? scale : 1)
			.overlay {
				if isFocused {
					RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
						.strokeBorder(MaskinColor.ink, lineWidth: 4)
				}
			}
			.shadow(color: .black.opacity(isFocused ? 0.5 : 0), radius: 30, y: 30)
			.opacity(configuration.isPressed ? 0.85 : 1)
			.animation(reduceMotion ? nil : .timingCurve(0.32, 0.72, 0, 1, duration: 0.25), value: isFocused)
	}
}

/// A capsule button 96 pt tall: the recommended option in the light fill, the rest on glass.
struct TVCapsuleLabel: View {
	let title: String
	var prominent = false
	var symbol: String?

	var body: some View {
		HStack(spacing: 14) {
			if let symbol { Image(systemName: symbol) }
			Text(title).lineLimit(1)
		}
		.font(.system(size: 32, weight: .semibold))
		.foregroundStyle(prominent ? MaskinSurface.onInverse : MaskinColor.ink)
		.padding(.horizontal, 44)
		.frame(maxWidth: .infinity, minHeight: 96)
		.background(prominent ? MaskinSurface.inverse : MaskinSurface.fillStrong, in: Capsule())
	}
}
