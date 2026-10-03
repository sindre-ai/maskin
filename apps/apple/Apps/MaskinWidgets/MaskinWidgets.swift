import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

@main
struct MaskinWidgetBundle: WidgetBundle {
	var body: some Widget {
		NeedsYouWidget()
		LockScreenWidget()
	}
}

/// Home screen: what needs you, with detail. Tapping opens the top decision.
struct NeedsYouWidget: Widget {
	static let kind = "io.maskin.widget.needs-you"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: Self.kind, provider: MaskinTimelineProvider()) { entry in
			NeedsYouEntryView(entry: entry)
				.widgetURL(tapURL(entry.state))
				.containerBackground(MaskinSurface.card, for: .widget)
		}
		.configurationDisplayName("Needs you")
		.description("Decisions your agents are waiting on, and what's unread.")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
	}
}

/// Lock screen: the count only.
struct LockScreenWidget: Widget {
	static let kind = "io.maskin.widget.lock-screen"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: Self.kind, provider: MaskinTimelineProvider()) { entry in
			LockScreenEntryView(entry: entry)
				.widgetURL(tapURL(entry.state))
				.containerBackground(for: .widget) { AccessoryWidgetBackground() }
		}
		.configurationDisplayName("Maskin")
		.description("How many decisions need you, at a glance.")
		.supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

/// A tap opens the top decision, else the inbox. Signed out has no link: the app just opens.
private func tapURL(_ state: WidgetState) -> URL? {
	if case .content(let snapshot) = state { return snapshot.tapURL }
	return nil
}

/// Maps the system's family onto the size the shared views take.
private struct NeedsYouEntryView: View {
	let entry: MaskinWidgetEntry
	@Environment(\.widgetFamily) private var family

	var body: some View {
		NeedsYouHomeView(
			entry: entry,
			size: family == .systemLarge ? .large : family == .systemMedium ? .medium : .small)
	}
}

private struct LockScreenEntryView: View {
	let entry: MaskinWidgetEntry
	@Environment(\.widgetFamily) private var family

	var body: some View {
		LockScreenView(
			entry: entry,
			kind: family == .accessoryCircular
				? .circular : family == .accessoryInline ? .inline : .rectangular)
	}
}
