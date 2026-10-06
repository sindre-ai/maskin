import SwiftUI

extension View {
	/// Floating glass surface. Uses iOS 26 / macOS 26 `glassEffect` where available and a
	/// thin material with a hairline edge elsewhere (older OS, other platforms).
	@ViewBuilder
	public func maskinGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
		if #available(iOS 26, macOS 26, watchOS 26, tvOS 26, *) {
			glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
		} else {
			background(.ultraThinMaterial, in: shape)
				.overlay(shape.stroke(MaskinSurface.glassBorder, lineWidth: 1))
		}
	}

	/// Glass in the pill shape floating bars use.
	public func maskinGlassCapsule(interactive: Bool = false) -> some View {
		maskinGlass(in: Capsule(), interactive: interactive)
	}
}
