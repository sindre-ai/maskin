import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A loop's state as one badge: draft, paused, a live rung of the autonomy ladder, or "Waiting on
/// you". Colours come from the shared status palette.
struct LoopPillView: View {
	let pill: LoopPill

	private var colors: MaskinColorPair { MaskinStatus.colors(for: Self.paletteKey(pill)) }

	static func paletteKey(_ pill: LoopPill) -> String {
		switch pill {
		case .draft: "new"
		case .paused: "paused"
		case .learning: "in_progress"
		case .supervised: "proposed"
		case .fullyAutonomous: "active"
		case .waitingOnYou: "at_risk"
		}
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

/// "2d 4h" / "35m" for a span of seconds.
enum LoopDurationText {
	static func string(_ seconds: TimeInterval) -> String {
		let formatter = DateComponentsFormatter()
		formatter.unitsStyle = .abbreviated
		formatter.maximumUnitCount = 2
		formatter.allowedUnits = [.day, .hour, .minute]
		return formatter.string(from: max(seconds, 60)) ?? "—"
	}
}
