import MaskinDesign
import SwiftUI

/// The Maskin mark: one open stroke `M14 54V18l18 22 18-22v36` on a 64 grid, drawn to fill `rect`.
/// Stroke it 9/64 of the width with square caps and mitre joins (`MaskinMark.strokeStyle`).
public struct MaskinMark: Shape {
	public init() {}

	public func path(in rect: CGRect) -> Path {
		let s = min(rect.width, rect.height) / 64
		let ox = rect.midX - 32 * s
		let oy = rect.midY - 32 * s
		func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
		var path = Path()
		path.move(to: p(14, 54))
		path.addLine(to: p(14, 18))
		path.addLine(to: p(32, 40))
		path.addLine(to: p(50, 18))
		path.addLine(to: p(50, 54))
		return path
	}

	/// The stroke for a mark drawn into a square of `side` points.
	public static func strokeStyle(side: CGFloat) -> StrokeStyle {
		StrokeStyle(lineWidth: side * 9 / 64, lineCap: .square, lineJoin: .miter, miterLimit: 10)
	}
}

/// The Maskin logo tile: #18181b container, white mark at 58% (62% at 18pt and below), corner
/// radius about 26% of the size. Same in light and dark; never a letter "M".
public struct MaskinLogoTile: View {
	private let size: CGFloat

	public init(size: CGFloat) { self.size = size }

	/// ~26% of the size (62 -> 15, 30 -> 9, 26 -> 8, 22 -> 6, 18 -> 6 in the handoff table).
	public static func cornerRadius(for size: CGFloat) -> CGFloat { (size * 0.26).rounded() }
	public static func markFraction(for size: CGFloat) -> CGFloat { size <= 18 ? 0.62 : 0.58 }

	public var body: some View {
		let side = size * Self.markFraction(for: size)
		let shape = RoundedRectangle(cornerRadius: Self.cornerRadius(for: size), style: .continuous)
		MaskinMark()
			.stroke(MaskinBrand.mark, style: MaskinMark.strokeStyle(side: side))
			.frame(width: side, height: side)
			.frame(width: size, height: size)
			.background(MaskinBrand.tile, in: shape)
			.overlay(shape.strokeBorder(MaskinBrand.ring, lineWidth: 1))
			.accessibilityHidden(true)
	}
}

/// The ONE place that decides which actor is the Maskin platform agent (interim: by display name,
/// case-insensitive; a backend flag is a follow-up). It renders as the logo tile, not initials.
public func isMaskinPlatformAgent(name: String) -> Bool {
	name.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare("Maskin") == .orderedSame
}

#Preview("Logo tile") {
	HStack(spacing: MaskinSpace.s5) {
		ForEach([18, 22, 26, 30, 62], id: \.self) { MaskinLogoTile(size: CGFloat($0)) }
	}
	.padding(MaskinSpace.s9)
	.background(MaskinSurface.grouped)
}
