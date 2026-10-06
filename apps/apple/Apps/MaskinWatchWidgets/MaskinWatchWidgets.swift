import MaskinCore
import SwiftUI
import WidgetKit

// Watch-face complications and the Smart Stack card. The views, provider and entry are the iPhone
// lock-screen widget's own files (compiled into this target by project.yml), so the phone and the
// watch can't drift: same snapshot, same fetch policy, same "nothing resolves to an id" rule.
// A rectangular entry carries `relevance`, which is what lifts the card in the Smart Stack when a
// decision is waiting.

@main
struct MaskinWatchWidgetBundle: WidgetBundle {
	var body: some Widget {
		NeedsYouComplication()
	}
}

struct NeedsYouComplication: Widget {
	static let kind = "io.maskin.widget.watch-needs-you"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: Self.kind, provider: MaskinTimelineProvider()) { entry in
			ComplicationView(entry: entry)
				.containerBackground(for: .widget) { AccessoryWidgetBackground() }
		}
		.configurationDisplayName("Needs you")
		.description("How many decisions your agents are waiting on.")
		.supportedFamilies([
			.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner,
		])
	}
}

private struct ComplicationView: View {
	let entry: MaskinWidgetEntry
	@Environment(\.widgetFamily) private var family

	var body: some View {
		switch family {
		case .accessoryRectangular:
			LockScreenView(entry: entry, kind: .rectangular)
		case .accessoryInline:
			LockScreenView(entry: entry, kind: .inline)
		case .accessoryCorner:
			// The corner draws the count inside the curve and the words along it.
			LockScreenView(entry: entry, kind: .circular)
				.widgetLabel { Text(cornerLabel(entry.state)) }
		default:
			LockScreenView(entry: entry, kind: .circular)
		}
	}
}

private func cornerLabel(_ state: WidgetState) -> String {
	switch state {
	case .content(let s) where !s.isEmpty: s.needsCount == 1 ? "1 needs you" : "\(s.needsCount) need you"
	case .content: "All clear"
	case .signedOut: "Sign in"
	case .unavailable: "Can't refresh"
	}
}
