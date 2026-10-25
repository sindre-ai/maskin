import MaskinDesign
import SwiftUI

/// What every watch page shares: the dark page with a Patina glow in the top-left corner, the type
/// scale, and the Chief of Staff tile. Colours, sizes and radii come from the design tokens.
struct WatchBackdrop: View {
	var body: some View {
		ZStack {
			Color.black
			RadialGradient(
				colors: [MaskinColor.patina800.opacity(0.9), MaskinColor.patina900.opacity(0.4), .clear],
				center: .topLeading, startRadius: 0, endRadius: 230)
		}
		.ignoresSafeArea()
	}
}

enum WatchType {
	static func title() -> Font { MaskinTypeface.sans(MaskinFontSize.t22, weight: .bold, relativeTo: .title2) }
	static func body() -> Font { MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body) }
	static func question() -> Font { MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body) }
	static func option(recommended: Bool) -> Font {
		MaskinTypeface.sans(MaskinFontSize.t16, weight: recommended ? .bold : .semibold, relativeTo: .body)
	}
	static func action() -> Font { MaskinTypeface.sans(MaskinFontSize.t17, weight: .bold, relativeTo: .body) }
	static func name() -> Font { MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline) }
	static func row() -> Font { MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .footnote) }
	static func caption() -> Font { MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .caption) }
	static func mono() -> Font { MaskinTypeface.mono(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption2) }
	static func microMono() -> Font { MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2) }
}

/// The 44 pt target every tappable thing on the wrist has.
enum WatchMetrics {
	static let target = MaskinSpace.touchMin
	static let badge: CGFloat = MaskinSpace.s13
	static let tile: CGFloat = 22
	static let ringStroke = MaskinSpace.s2
	static let spinner: CGFloat = 30
	/// The play and pause button of the briefing player.
	static let player: CGFloat = 84
	static let playerStroke = MaskinSpace.s3
}

/// The small square with initials that stands for an agent: "Co" for the Chief of Staff.
struct WatchTile: View {
	let name: String

	private var initials: String {
		if name == "Chief of Staff" { return "Co" }
		return String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
	}

	var body: some View {
		Text(initials)
			.font(MaskinTypeface.sans(MaskinFontSize.t11, weight: .bold, relativeTo: .caption2))
			.foregroundStyle(MaskinColor.avFg)
			.frame(width: WatchMetrics.tile, height: WatchMetrics.tile)
			.background(MaskinGradient.avatar, in: RoundedRectangle(cornerRadius: MaskinRadius.key, style: .continuous))
			.accessibilityHidden(true)
	}
}

/// The Patina count badge on the `badge` gradient: how many decisions wait.
struct WatchCountBadge: View {
	let count: Int

	var body: some View {
		Text("\(count)")
			.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold, relativeTo: .caption))
			.foregroundStyle(MaskinColor.badgeFg)
			.frame(minWidth: WatchMetrics.badge, minHeight: WatchMetrics.badge)
			.background(MaskinGradient.badge, in: Circle())
			.accessibilityLabel(count == 1 ? "1 needs you" : "\(count) need you")
	}
}

/// A page title with the count badge: "For you" with 3 waiting.
struct WatchPageTitle: View {
	let title: String
	var count: Int = 0

	var body: some View {
		HStack {
			Text(title).font(WatchType.title()).foregroundStyle(MaskinColor.ink)
			Spacer(minLength: 0)
			if count > 0 { WatchCountBadge(count: count) }
		}
	}
}

/// A full-width capsule at the 44 pt minimum: the recommended / primary action on the inverse
/// surface (ink, never a colour), everything else on glass.
struct WatchCapsule: View {
	let title: String
	var prominent = false
	var font: Font = WatchType.question()

	var body: some View {
		Text(title)
			.font(font)
			.lineLimit(2)
			.multilineTextAlignment(.center)
			.foregroundStyle(prominent ? MaskinSurface.onInverse : MaskinColor.ink)
			.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
			.padding(.horizontal, MaskinSpace.s7)
			.background(
				prominent ? AnyShapeStyle(MaskinSurface.inverse) : AnyShapeStyle(MaskinSurface.fillStrong),
				in: Capsule())
			.contentShape(Capsule())
	}
}

/// A quiet text action ("Cancel", "Skip") that still has a 44 pt target.
struct WatchQuietButton: View {
	let title: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Text(title).font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}
}

/// The loading spinner: a Patina arc turning on a faint ring. Held still under Reduce Motion.
struct WatchSpinner: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var turning = false

	var body: some View {
		Circle()
			.stroke(MaskinSurface.fillStrong, lineWidth: WatchMetrics.ringStroke)
			.overlay {
				Circle().trim(from: 0, to: 0.25)
					.stroke(MaskinColor.sigHi, style: StrokeStyle(lineWidth: WatchMetrics.ringStroke, lineCap: .round))
					.rotationEffect(.degrees(turning ? 360 : 0))
			}
			.frame(width: WatchMetrics.spinner, height: WatchMetrics.spinner)
			.onAppear {
				guard !reduceMotion else { return }
				withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turning = true }
			}
			.accessibilityLabel("Loading")
	}
}
