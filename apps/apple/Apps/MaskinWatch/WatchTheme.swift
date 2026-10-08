import MaskinDesign
import SwiftUI

/// What every watch page shares: the dark page with a Patina glow in the top-left corner, the type
/// scale, and the Chief of Staff tile. Colours and gradients come from the design tokens.
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
	static func title() -> Font { MaskinTypeface.sans(22, weight: .bold, relativeTo: .title2) }
	static func body() -> Font { MaskinTypeface.sans(16, relativeTo: .body) }
	static func question() -> Font { MaskinTypeface.sans(16, weight: .semibold, relativeTo: .body) }
	static func name() -> Font { MaskinTypeface.sans(15, weight: .semibold, relativeTo: .subheadline) }
	static func row() -> Font { MaskinTypeface.sans(14, weight: .semibold, relativeTo: .footnote) }
	static func caption() -> Font { MaskinTypeface.sans(13, relativeTo: .caption) }
	static func mono() -> Font { MaskinTypeface.mono(12, weight: .medium, relativeTo: .caption2) }
	static func microMono() -> Font { MaskinTypeface.mono(11, weight: .semibold, relativeTo: .caption2) }
}

/// The small square with initials that stands for an agent: "Co" for the Chief of Staff.
struct WatchTile: View {
	let name: String
	var size: CGFloat = 22

	private var initials: String {
		if name == "Chief of Staff" { return "Co" }
		return String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
	}

	var body: some View {
		Text(initials)
			.font(MaskinTypeface.sans(size * 0.5, weight: .bold, relativeTo: .caption2))
			.foregroundStyle(MaskinColor.avFg)
			.frame(width: size, height: size)
			.background(MaskinGradient.avatar, in: RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
			.accessibilityHidden(true)
	}
}

/// A page title with the Patina count badge: "For you" with 3 waiting.
struct WatchPageTitle: View {
	let title: String
	var count: Int = 0

	var body: some View {
		HStack {
			Text(title).font(WatchType.title()).foregroundStyle(MaskinColor.ink)
			Spacer(minLength: 0)
			if count > 0 {
				Text("\(count)")
					.font(MaskinTypeface.sans(15, weight: .bold, relativeTo: .caption))
					.foregroundStyle(MaskinColor.badgeFg)
					.frame(minWidth: 26, minHeight: 26)
					.background(MaskinGradient.badge, in: Circle())
					.accessibilityLabel("\(count) need you")
			}
		}
	}
}
