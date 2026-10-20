import MaskinDesign
import SwiftUI

/// The tvOS focus look: lifted and scaled up, a soft shine rim and a deep shadow, 0.3 s. Reduce
/// Motion drops the scale and keeps the rim. Use it on every focusable control and card.
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
		let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
		configuration.label
			.scaleEffect(isFocused && !reduceMotion ? scale : 1)
			// Lifted 6 pt and tipped 2 degrees toward the viewer (parallax); Reduce Motion keeps
			// only the rim and the shadow.
			.offset(y: isFocused && !reduceMotion ? -6 : 0)
			.rotation3DEffect(
				.degrees(isFocused && !reduceMotion ? 2 : 0), axis: (x: 1, y: 0, z: 0), perspective: 0.5
			)
			.overlay {
				if isFocused {
					// Shine rim: a 1.5 pt 30% edge and a 1 pt highlight just inside it.
					shape.strokeBorder(Color.white.opacity(0.3), lineWidth: 1.5)
					shape.inset(by: 1.5).strokeBorder(
						LinearGradient(
							colors: [Color.white.opacity(0.22), Color.white.opacity(0)],
							startPoint: .top, endPoint: .bottom),
						lineWidth: 1)
				}
			}
			.shadow(color: .black.opacity(isFocused ? 0.6 : 0), radius: 40, y: 40)
			.opacity(configuration.isPressed ? 0.85 : 1)
			.animation(reduceMotion ? nil : .timingCurve(0.32, 0.72, 0, 1, duration: 0.3), value: isFocused)
	}
}

/// A capsule button 96 pt tall: the recommended option in the light fill, the rest on glass.
struct TVCapsuleLabel: View {
	let title: String
	var prominent = false
	var symbol: String?
	/// The slim 72 pt control the briefing player uses: as wide as its label, not the column.
	var slim = false

	var body: some View {
		HStack(spacing: 14) {
			if let symbol { Image(systemName: symbol) }
			Text(title).lineLimit(1)
		}
		.font(.system(size: slim ? 30 : 32, weight: .semibold))
		.foregroundStyle(prominent ? MaskinSurface.onInverse : MaskinColor.ink)
		.padding(.horizontal, slim ? 40 : 44)
		.frame(maxWidth: slim ? nil : .infinity, minHeight: slim ? 72 : 96)
		.background(prominent ? MaskinSurface.inverse : MaskinSurface.fillStrong, in: Capsule())
	}
}

/// Wraps its children onto as many lines as the width needs, left to right.
struct TVWrapLayout: Layout {
	var spacing: CGFloat = 14

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		arrange(proposal.width ?? .infinity, subviews).size
	}

	func placeSubviews(
		in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
	) {
		let laid = arrange(bounds.width, subviews)
		for (index, origin) in laid.origins.enumerated() {
			subviews[index].place(
				at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
		}
	}

	private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
		var origins: [CGPoint] = []
		var x: CGFloat = 0
		var y: CGFloat = 0
		var rowHeight: CGFloat = 0
		var maxX: CGFloat = 0
		for subview in subviews {
			let size = subview.sizeThatFits(.unspecified)
			if x > 0, x + size.width > width {
				x = 0
				y += rowHeight + spacing
				rowHeight = 0
			}
			origins.append(CGPoint(x: x, y: y))
			x += size.width + spacing
			rowHeight = max(rowHeight, size.height)
			maxX = max(maxX, x - spacing)
		}
		return (CGSize(width: maxX, height: y + rowHeight), origins)
	}
}
