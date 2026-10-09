import MaskinDesign
import SwiftUI

/// The Maskin logo tile for the Live Activity: a black tile with the white "M" mark (spec: 64 grid,
/// stroke 9, mark at 58% of the tile, 62% at 18pt and below, radius 26%). The extension does not
/// link MaskinUI, so it draws its own copy; the geometry matches the shared mark.
struct LiveActivityMarkTile: View {
	var size: CGFloat = 22

	private static let tile = Color(light: RGBA(0x18181B), dark: RGBA(0x18181B))

	var body: some View {
		let markScale = size <= 18 ? 0.62 : 0.58
		let mark = size * markScale
		LiveActivityMarkShape()
			.stroke(Color.white, style: StrokeStyle(lineWidth: mark * 9 / 64, lineCap: .square, lineJoin: .miter))
			.frame(width: mark, height: mark)
			.frame(width: size, height: size)
			.background(Self.tile, in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
			.accessibilityHidden(true)
	}
}

private struct LiveActivityMarkShape: Shape {
	func path(in rect: CGRect) -> Path {
		let s = rect.width / 64
		func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
			CGPoint(x: rect.minX + x * s, y: rect.minY + y * s)
		}
		var path = Path()
		path.move(to: p(14, 54))
		path.addLine(to: p(14, 18))
		path.addLine(to: p(32, 40))
		path.addLine(to: p(50, 18))
		path.addLine(to: p(50, 54))
		return path
	}
}

/// The agent's tile: its first letter on the signal tint (the platform agent "Maskin" shows the
/// logo tile instead, never a letter).
struct LiveActivityAgentTile: View {
	let name: String
	var size: CGFloat = 44

	var body: some View {
		Group {
			if name.trimmingCharacters(in: .whitespaces).lowercased() == "maskin" {
				LiveActivityMarkTile(size: size)
			} else {
				Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
					.font(.system(size: size * 0.4, weight: .bold))
					.foregroundStyle(MaskinColor.sigInk)
					.frame(width: size, height: size)
					.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
			}
		}
		.accessibilityHidden(true)
	}
}
