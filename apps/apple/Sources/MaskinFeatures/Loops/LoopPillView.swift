import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A loop's state as one badge. Patina marks a flow that is running or waiting on you, grey marks
/// one that is stopped; the rung's name carries the difference between the running states.
struct LoopPillView: View {
	let pill: LoopPill

	private var colors: (fg: Color, bg: Color) {
		pill.isLive ? (MaskinColor.sigInk, MaskinColor.sigTint) : (MaskinColor.ink4, MaskinSurface.fill)
	}

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			if pill.isLive {
				Circle().fill(colors.fg).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
			}
			Text(pill.label).lineLimit(1)
		}
		.maskinText(.caption)
		.foregroundStyle(colors.fg)
		.padding(.horizontal, MaskinSpace.s4)
		.padding(.vertical, MaskinSpace.s1)
		.background(colors.bg, in: Capsule())
		.fixedSize()
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("State \(pill.label)")
	}
}

/// The "Needs you" chip: `sigInk` on `sigTint`, the only colour it ever wears.
struct NeedsYouChip: View {
	var body: some View {
		Text("Needs you")
			.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: MaskinFontWeight.w650, relativeTo: .caption))
			.foregroundStyle(MaskinColor.sigInk)
			.padding(.horizontal, MaskinSpace.s5)
			.padding(.vertical, MaskinSpace.s2)
			.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: MaskinRadius.panel, style: .continuous))
			.fixedSize()
	}
}

/// "2d 4h" / "35m" for a span of seconds.
enum LoopDurationText {
	static func string(_ seconds: TimeInterval) -> String { LoopDurationFormat.string(seconds) }
}
