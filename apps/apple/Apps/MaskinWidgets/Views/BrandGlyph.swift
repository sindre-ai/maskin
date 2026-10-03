import MaskinDesign
import SwiftUI

/// The Maskin mark (the app icon's geometry, viewBox 80x80). The package's own `BrandMark` lives
/// in MaskinFeatures, which the extension must not link, so the widget draws it itself.
struct BrandGlyph: View {
	var size: CGFloat = 20

	var body: some View {
		GlyphShape()
			.stroke(
				MaskinSurface.onInverse,
				style: StrokeStyle(lineWidth: size * 6 / 80, lineCap: .square, lineJoin: .miter)
			)
			.frame(width: size, height: size)
			.background(
				MaskinSurface.inverse,
				in: RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous)
			)
			.accessibilityHidden(true)
	}
}

/// Just the strokes, for places that tint (the lock screen).
struct GlyphShape: Shape {
	func path(in rect: CGRect) -> Path {
		let s = rect.width / 80
		func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
			CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
		}
		var path = Path()
		path.move(to: p(17, 60))
		path.addLine(to: p(17, 20))
		path.addLine(to: p(40, 46))
		path.addLine(to: p(63, 20))
		path.addLine(to: p(63, 60))
		return path
	}
}
