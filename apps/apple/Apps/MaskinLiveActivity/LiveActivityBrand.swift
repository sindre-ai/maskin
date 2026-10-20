import MaskinDesign
import SwiftUI

/// The Maskin logo tile for the Live Activity: a black tile with the white "M" mark (spec: 64 grid,
/// stroke 9, mark at 58% of the tile, 62% at 18pt and below, radius 26%). The extension does not
/// link MaskinUI, so it draws its own copy; the geometry matches the shared mark.
struct LiveActivityMarkTile: View {
	var size: CGFloat = 22

	var body: some View {
		let markScale = size <= 18 ? 0.62 : 0.58
		let mark = size * markScale
		LiveActivityMarkShape()
			.stroke(Color.white, style: StrokeStyle(lineWidth: mark * 9 / 64, lineCap: .square, lineJoin: .miter))
			.frame(width: mark, height: mark)
			.frame(width: size, height: size)
			.background(MaskinBrand.tile, in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
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

/// The agent's tile: up to two letters on the Patina avatar gradient, as in the mockup ("Co"); the
/// platform agent "Maskin" shows the logo tile instead, never letters.
struct LiveActivityAgentTile: View {
	let name: String
	var size: CGFloat = 44

	var body: some View {
		Group {
			if name.trimmingCharacters(in: .whitespaces).lowercased() == "maskin" {
				LiveActivityMarkTile(size: size)
			} else {
				let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
				Text(Self.initials(name))
					.font(MaskinTypeface.sans(size * 0.4, weight: .bold, relativeTo: .caption))
					.foregroundStyle(MaskinColor.avFg)
					.frame(width: size, height: size)
					.background(MaskinGradient.avatar, in: shape)
			}
		}
		.accessibilityHidden(true)
	}

	/// First two letters of the first word ("Chief of Staff" gives "Ch" in the mockup's "Co" style).
	static func initials(_ name: String) -> String {
		let word = name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? "?"
		let letters = word.filter { $0.isLetter || $0.isNumber }
		guard let first = letters.first else { return "?" }
		return String(first).uppercased() + letters.dropFirst().prefix(1).lowercased()
	}
}

/// The "someone is talking" level bars (4 x 4pt, signal). A Live Activity cannot animate on its
/// own, so the heights are fixed; they dim while muted.
struct LiveActivityLevelBars: View {
	var muted = false
	private static let heights: [CGFloat] = [0.5, 1, 0.7, 0.85]

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			ForEach(Array(Self.heights.enumerated()), id: \.offset) { _, h in
				Capsule().fill(MaskinColor.sigHi)
					.frame(width: 4, height: 24 * h)
			}
		}
		.frame(height: 24)
		.opacity(muted ? 0.35 : 1)
		.accessibilityHidden(true)
	}
}
