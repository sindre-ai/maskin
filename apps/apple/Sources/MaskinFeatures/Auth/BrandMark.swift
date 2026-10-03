import MaskinDesign
import SwiftUI

/// The Maskin mark: an "M" stroked on a rounded plate (the app icon's geometry, viewBox 80x80).
/// Drawn rather than loaded from an asset so the package needs no bundle, and the plate/stroke
/// pair is the inverse surface tokens: dark plate in light mode, light plate in dark mode.
struct BrandMark: View {
	var size: CGFloat = 56

	var body: some View {
		MarkShape()
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

private struct MarkShape: Shape {
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
