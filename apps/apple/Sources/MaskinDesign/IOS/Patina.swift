import SwiftUI

/// Patina gradients and the brand-pass colours the CSS-to-Swift generator can't express. Hand-written
/// beside the generated tokens, never in them. The flat Patina colours (`MaskinColor.sig`,
/// `sigInk`, `sigTint`, `badgeFg`, `avFg`, `stFg`, `stLab`, `wash*`, `pill*`, `patina50...900`) are
/// generated; the gradient tokens (`--badge`, `--av-bg`, `--st-bg`) exist in `colors.css` for the
/// web but are skipped by the generator, so their native equivalents live here with the same stops.
public enum MaskinGradient {
	/// A CSS `linear-gradient(<angle>deg, ...)` as a SwiftUI gradient: 0deg runs bottom to top,
	/// 90deg left to right, 180deg top to bottom.
	/// Unit-square start and end points for a CSS angle.
	static func points(angle: Double) -> (start: UnitPoint, end: UnitPoint) {
		let r = angle * .pi / 180
		let dx = sin(r) / 2
		let dy = -cos(r) / 2
		return (UnitPoint(x: 0.5 - dx, y: 0.5 - dy), UnitPoint(x: 0.5 + dx, y: 0.5 + dy))
	}

	static func css(angle: Double, _ stops: [Gradient.Stop]) -> LinearGradient {
		let p = points(angle: angle)
		return LinearGradient(stops: stops, startPoint: p.start, endPoint: p.end)
	}

	private static func even(_ colors: [Color]) -> [Gradient.Stop] {
		let last = Double(max(colors.count - 1, 1))
		return colors.enumerated().map { Gradient.Stop(color: $1, location: Double($0) / last) }
	}

	private static func pair(_ lightA: UInt32, _ lightB: UInt32, _ darkA: UInt32, _ darkB: UInt32)
		-> [Color]
	{
		[
			Color(light: RGBA(lightA), dark: RGBA(darkA)),
			Color(light: RGBA(lightB), dark: RGBA(darkB)),
		]
	}

	/// Unread badges (fill); pair with `MaskinColor.badgeFg`.
	public static let badge = css(
		angle: 150, even(pair(0xACD6CD, 0x7DBCB0, 0x7DBCB0, 0x4F9E91)))

	/// Every agent and user avatar (fill); pair with `MaskinColor.avFg`.
	public static let avatar = css(
		angle: 150, even(pair(0xE6F2EF, 0xACD6CD, 0x20564F, 0x12302C)))

	/// An unseen brief card's fill; pair with `stFg` / `stLab`.
	public static let unseenBrief = css(
		angle: 165,
		[
			.init(color: Color(light: RGBA(0xFFFFFF), dark: RGBA(0x2F7D74)), location: 0),
			.init(color: Color(light: RGBA(0xF3F8F7), dark: RGBA(0x1A443F)), location: 0.55),
			.init(color: Color(light: RGBA(0xDCECE8), dark: RGBA(0x12302C)), location: 1),
		])

	/// Loop progress ring stroke, top-leading to bottom-trailing.
	public static let ring = css(
		angle: 135, even(pair(0x7DBCB0, 0x20564F, 0x7DBCB0, 0x20564F)))

	/// A paused loop's ring: flat grey.
	public static let ringPaused = Color(light: RGBA(0xC4C4CC), dark: RGBA(0xC4C4CC))

	/// The recommended decision button: ink, top to bottom (white text in both modes).
	public static let decisionInk = css(angle: 180, even(pair(0x2C2C31, 0x18181B, 0x2C2C31, 0x18181B)))

	/// The Dynamic Island agent tile; white initial on top.
	public static let islandTile = css(
		angle: 150, even(pair(0x7DBCB0, 0x2F7D74, 0x7DBCB0, 0x2F7D74)))

	/// The full-screen brief viewer's dark backdrop (dark in both modes).
	public static let briefViewer = css(
		angle: 170,
		[
			.init(color: Color(light: RGBA(0x1D2624), dark: RGBA(0x1D2624)), location: 0),
			.init(color: Color(light: RGBA(0x0D1110), dark: RGBA(0x0D1110)), location: 0.7),
			.init(color: Color(light: RGBA(0x0D1110), dark: RGBA(0x0D1110)), location: 1),
		])

	/// Outcome score card bars, left to right. Urgency is shade, not hue.
	public enum Outcome {
		public static let atRisk = css(angle: 90, even(pair(0x4F9E91, 0x12302C, 0x4F9E91, 0x12302C)))
		public static let needsYou = css(angle: 90, even(pair(0x7DBCB0, 0x20564F, 0x7DBCB0, 0x20564F)))
		public static let onTrack = css(angle: 90, even(pair(0xACD6CD, 0x2F7D74, 0xACD6CD, 0x2F7D74)))
		public static let watch = css(angle: 90, even(pair(0xD5EBE6, 0x7DBCB0, 0xD5EBE6, 0x7DBCB0)))
	}
}

/// Patina colours that are fixed in both modes and have no `colors.css` counterpart.
public enum MaskinPatina {
	/// An @mention inside your own ink bubble: #d4d4d8 on the light-mode ink, flipped on the dark-mode
	/// (light) bubble so it still reads.
	public static let mentionOnInverse = Color(light: RGBA(0xD4D4D8), dark: RGBA(0x52525B))
	/// A brief card's resting shadow (the card has no ring or border).
	public static let cardShadow = Color(
		light: RGBA(red: 18, green: 48, blue: 44, alpha: 0.06), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.3))
	/// The recommended decision button's shadow.
	public static let decisionShadow = Color(
		light: RGBA(red: 18, green: 48, blue: 44, alpha: 0.22), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.4))
	/// Full-screen brief viewer accent.
	public static let viewerAccent = Color(light: RGBA(0x92D6CA), dark: RGBA(0x92D6CA))
	/// Brief viewer progress ring, start and end.
	public static let viewerRing = css(0x6CC4B5, 0x2F7D74)
	/// Outcome dots by status.
	public static let dotAtRisk = Color(light: RGBA(0x12302C), dark: RGBA(0x12302C))
	public static let dotNeedsYou = Color(light: RGBA(0x20564F), dark: RGBA(0x20564F))
	public static let dotOnTrack = Color(light: RGBA(0x2F7D74), dark: RGBA(0x2F7D74))
	public static let dotWatch = Color(light: RGBA(0x7DBCB0), dark: RGBA(0x7DBCB0))

	private static func css(_ a: UInt32, _ b: UInt32) -> LinearGradient {
		MaskinGradient.css(
			angle: 135,
			[
				.init(color: Color(light: RGBA(a), dark: RGBA(a)), location: 0),
				.init(color: Color(light: RGBA(b), dark: RGBA(b)), location: 1),
			])
	}
}

/// The ambient wash behind every root screen and sheet: three soft Patina radial glows over the
/// canvas, so Liquid Glass bars have colour to refract. Fixed (it never scrolls). Drawn as plain
/// canvas when Reduce Transparency is on.
public struct AmbientBackground: View {
	/// One radial glow, in CSS terms: radii as a fraction of the canvas width / height, centre as a
	/// fraction of both, fading to clear at `fade` of the radius.
	struct Layer: Equatable {
		var radiusX: Double
		var radiusY: Double
		var centerX: Double
		var centerY: Double
		var fade: Double
	}

	/// Bottom (behind the tab bar), top-leading, top-trailing: the prototype's three layers.
	static let bottom = Layer(radiusX: 0.90, radiusY: 0.22, centerX: 0.5, centerY: 1.04, fade: 0.75)
	static let topLeading = Layer(radiusX: 0.95, radiusY: 0.34, centerX: 0.12, centerY: 0, fade: 0.72)
	static let topTrailing = Layer(radiusX: 0.70, radiusY: 0.26, centerX: 1, centerY: 0.06, fade: 0.70)

	/// Sheets drop the bottom layer.
	let showsBottom: Bool
	@Environment(\.accessibilityReduceTransparency) private var reduceTransparency

	public init(showsBottom: Bool = true) { self.showsBottom = showsBottom }

	public var body: some View {
		ZStack {
			MaskinSurface.grouped
			if !reduceTransparency {
				GeometryReader { proxy in
					ZStack {
						if showsBottom { glow(Self.bottom, MaskinColor.wash3, in: proxy.size) }
						glow(Self.topLeading, MaskinColor.wash, in: proxy.size)
						glow(Self.topTrailing, MaskinColor.wash2, in: proxy.size)
					}
				}
			}
		}
		.ignoresSafeArea()
		.accessibilityHidden(true)
		.allowsHitTesting(false)
	}

	private func glow(_ layer: Layer, _ color: Color, in size: CGSize) -> some View {
		let rx = layer.radiusX * size.width
		let ry = layer.radiusY * size.height
		return Rectangle()
			.fill(
				RadialGradient(
					stops: [
						.init(color: color, location: 0),
						.init(color: color.opacity(0), location: layer.fade),
					], center: .center, startRadius: 0, endRadius: max(rx, 1))
			)
			.frame(width: rx * 2, height: rx * 2)
			.scaleEffect(x: 1, y: ry / max(rx, 1))
			.position(x: layer.centerX * size.width, y: layer.centerY * size.height)
	}
}

extension View {
	/// The ambient wash as this view's fixed backdrop. Use it where a screen used to set
	/// `MaskinSurface.grouped`; pass `showsBottom: false` on a sheet.
	public func ambientBackground(showsBottom: Bool = true) -> some View {
		background(AmbientBackground(showsBottom: showsBottom))
	}
}
