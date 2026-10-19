import SwiftUI

/// Glass that gives way to an opaque surface when Reduce Transparency is on.
private struct MaskinGlassModifier<S: Shape>: ViewModifier {
	let shape: S
	let interactive: Bool
	@Environment(\.accessibilityReduceTransparency) private var reduceTransparency

	@ViewBuilder
	func body(content: Content) -> some View {
		if reduceTransparency {
			content
				.background(MaskinSurface.card, in: shape)
				.overlay(shape.stroke(MaskinSurface.glassBorder, lineWidth: 1))
		} else if #available(iOS 26, macOS 26, watchOS 26, tvOS 26, *) {
			content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
		} else {
			content
				.background(.ultraThinMaterial, in: shape)
				.overlay(shape.stroke(MaskinSurface.glassBorder, lineWidth: 1))
		}
	}
}

extension View {
	/// Floating glass surface. Uses iOS 26 / macOS 26 `glassEffect` where available and a
	/// thin material with a hairline edge elsewhere; an opaque raised surface under Reduce Transparency.
	public func maskinGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
		modifier(MaskinGlassModifier(shape: shape, interactive: interactive))
	}

	/// Glass in the pill shape floating bars use.
	public func maskinGlassCapsule(interactive: Bool = false) -> some View {
		maskinGlass(in: Capsule(), interactive: interactive)
	}
}
