import MaskinAPI
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

// Watch-face complications and the Smart Stack card, drawn for the wrist rather than borrowed from
// the iPhone lock-screen widget. The data side is shared (same snapshot loader, same fetch policy,
// same "nothing resolves to an id" rule); the four families are Watch-specific:
//   corner       the needs-you count with a Patina gauge
//   circular     the top flow's progress ring
//   rectangular  "Needs you · <next decision>" on two lines
//   inline       "2 need you"
// plus a circular Ask complication, a microphone that opens the app ready to ask.
// The rectangular entry carries `relevance`, which lifts the card in the Smart Stack when a
// decision is waiting. Patina is signal only: the gauge and ring are the only accent drawn.

/// The URLs a complication opens; the watch app's `onOpenURL` (in `WatchHome`) routes them.
/// Duplicated there because the two targets share no source file for it.
private enum WatchLink {
	static let needsYou = URL(string: "maskin-watch://needs-you")!
	static let ask = URL(string: "maskin-watch://ask")!

	/// The circular ring opens the flow it draws; every other family opens Needs you.
	static func flow(_ id: String) -> URL? {
		id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
			.flatMap { URL(string: "maskin-watch://flow/\($0)") }
	}
}

@main
struct MaskinWatchWidgetBundle: WidgetBundle {
	var body: some Widget {
		NeedsYouComplication()
		AskComplication()
	}
}

/// A microphone on the watch face: one tap opens the app on Home, where the mic is.
struct AskComplication: Widget {
	static let kind = "io.maskin.widget.watch-ask"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: Self.kind, provider: AskProvider()) { _ in
			Image(systemName: "mic.fill")
				.font(.title3)
				.foregroundStyle(MaskinColor.sigHi)
				.widgetAccentable()
				.accessibilityLabel("Ask Maskin")
				.widgetURL(WatchLink.ask)
				.containerBackground(for: .widget) { AccessoryWidgetBackground() }
		}
		.configurationDisplayName("Ask")
		.description("Ask your Chief of Staff by voice.")
		.supportedFamilies([.accessoryCircular])
	}
}

struct AskEntry: TimelineEntry {
	let date: Date
}

/// Nothing to refresh: the button looks the same all day.
struct AskProvider: TimelineProvider {
	func placeholder(in context: Context) -> AskEntry { AskEntry(date: Date()) }

	func getSnapshot(in context: Context, completion: @escaping (AskEntry) -> Void) {
		completion(AskEntry(date: Date()))
	}

	func getTimeline(in context: Context, completion: @escaping (Timeline<AskEntry>) -> Void) {
		completion(Timeline(entries: [AskEntry(date: Date())], policy: .never))
	}
}

struct NeedsYouComplication: Widget {
	static let kind = "io.maskin.widget.watch-needs-you"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: Self.kind, provider: WatchComplicationProvider()) { entry in
			ComplicationView(entry: entry)
				.containerBackground(for: .widget) { AccessoryWidgetBackground() }
		}
		.configurationDisplayName("Needs you")
		.description("How many decisions your agents are waiting on, and how your top flow is doing.")
		.supportedFamilies([
			.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner,
		])
	}
}

// MARK: - Timeline

/// The top flow, reduced to what a ring needs.
struct ComplicationFlow: Equatable, Sendable {
	var id: String
	var name: String
	var progress: Double
	var paused: Bool
}

struct WatchComplicationEntry: TimelineEntry {
	let date: Date
	let state: WidgetState
	let flow: ComplicationFlow?

	var relevance: TimelineEntryRelevance? {
		TimelineEntryRelevance(score: WidgetPolicy.relevance(of: state))
	}
}

struct WatchComplicationProvider: TimelineProvider {
	typealias Entry = WatchComplicationEntry

	private static var baseURL: URL {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		return raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
	}

	func placeholder(in context: Context) -> Entry {
		Entry(date: Date(), state: .content(.sample()), flow: .sample)
	}

	func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
		if context.isPreview {
			completion(Entry(date: Date(), state: .content(.sample()), flow: .sample))
			return
		}
		nonisolated(unsafe) let completion = completion
		Task {
			let now = Date()
			let (state, flow) = await Self.load()
			completion(Entry(date: now, state: state.resolved(at: now), flow: flow))
		}
	}

	func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
		nonisolated(unsafe) let completion = completion
		Task {
			let now = Date()
			let (state, flow) = await Self.load()
			let plan = WidgetPolicy.plan(for: state, now: now)
			let entries = plan.entries.map { Entry(date: $0, state: state.resolved(at: $0), flow: flow) }
			completion(Timeline(entries: entries, policy: .after(plan.reloadAfter)))
		}
	}

	private static func load() async -> (WidgetState, ComplicationFlow?) {
		async let state = WidgetSnapshotLoader.live(baseURL: baseURL).load()
		async let flow = ComplicationFlowLoader.load(baseURL: baseURL)
		return await (state, flow)
	}
}

/// The top flow for the circular ring: one needing the wearer, else the first running one. It is
/// garnish like the feed's sender names: a failure falls back to the last ring drawn and never
/// blanks the complication.
enum ComplicationFlowLoader {
	private static let defaultsKey = "watch.complication.flow.v1"

	static func load(baseURL: URL) async -> ComplicationFlow? {
		guard let data = try? KeychainSecretStore().read(),
			let session = try? JSONDecoder().decode(StoredSession.self, from: data),
			let workspaceId = session.workspaceId, !workspaceId.isEmpty, !session.apiKey.isEmpty
		else {
			UserDefaults.standard.removeObject(forKey: defaultsKey)
			return nil
		}
		let credentials = MaskinCredentials(apiKey: session.apiKey, workspaceId: workspaceId)
		let client = MaskinClient.make(
			serverURL: baseURL, clientSource: "watchos", credentials: { credentials })
		let source = APILoopsSource(client: client, workspaceID: workspaceId)
		do {
			let loops = try await withDeadline(8) { try await source.loops() }
			let live = loops.filter { $0.status != .draft }
			guard let top = live.first(where: { $0.waitingCount > 0 }) ?? live.first else {
				UserDefaults.standard.removeObject(forKey: defaultsKey)
				return nil
			}
			let flow = ComplicationFlow(id: top.id, name: top.displayName, progress: top.ringProgress, paused: top.isPaused)
			store(flow)
			return flow
		} catch {
			return cached()
		}
	}

	private static func store(_ flow: ComplicationFlow) {
		UserDefaults.standard.set(
			["id": flow.id, "name": flow.name, "progress": flow.progress, "paused": flow.paused], forKey: defaultsKey)
	}

	private static func cached() -> ComplicationFlow? {
		guard let raw = UserDefaults.standard.dictionary(forKey: defaultsKey),
			let id = raw["id"] as? String, let name = raw["name"] as? String,
			let progress = raw["progress"] as? Double
		else { return nil }
		return ComplicationFlow(id: id, name: name, progress: progress, paused: raw["paused"] as? Bool ?? false)
	}
}

/// Races `operation` against a timer; the loser is cancelled. The widget process is killed soon
/// after its budget, so a slow network must fall back to the cached ring.
private func withDeadline<T: Sendable>(
	_ seconds: TimeInterval, _ operation: @escaping @Sendable () async throws -> T
) async throws -> T {
	try await withThrowingTaskGroup(of: T.self) { group in
		group.addTask { try await operation() }
		group.addTask {
			try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
			throw WidgetLoadError.timeout
		}
		defer { group.cancelAll() }
		guard let first = try await group.next() else { throw WidgetLoadError.timeout }
		return first
	}
}

extension ComplicationFlow {
	/// Gallery data. Invented, never real content.
	static let sample = ComplicationFlow(id: "sample", name: "Outreach", progress: 0.62, paused: false)
}

// MARK: - Views

private struct ComplicationView: View {
	let entry: WatchComplicationEntry
	@Environment(\.widgetFamily) private var family

	var body: some View {
		switch family {
		case .accessoryCorner: CornerView(state: entry.state).widgetURL(WatchLink.needsYou)
		case .accessoryRectangular: RectangularView(state: entry.state).widgetURL(WatchLink.needsYou)
		case .accessoryInline: InlineView(state: entry.state).widgetURL(WatchLink.needsYou)
		default:
			CircularView(state: entry.state, flow: entry.flow).widgetURL(circularURL)
		}
	}

	/// The flow the ring draws, else Needs you when the face shows the count instead.
	private var circularURL: URL {
		if case .content = entry.state, let id = entry.flow?.id, let url = WatchLink.flow(id) { return url }
		return WatchLink.needsYou
	}
}

/// The gauge runs from Patina 300 to 600: the accent, drawn only as a signal.
private let patinaGauge = Gradient(colors: [MaskinColor.patina300, MaskinColor.patina600])

/// More than this many waiting fills the corner gauge; it is a signal, not a scale.
private let cornerGaugeCap = 5

private func needsPhrase(_ n: Int) -> String { n == 1 ? "1 needs you" : "\(n) need you" }

/// Corner: the count in the curve, a Patina gauge along it.
private struct CornerView: View {
	let state: WidgetState

	var body: some View {
		switch state {
		case .content(let s) where !s.isEmpty:
			Text(s.needsCount > 99 ? "99+" : "\(s.needsCount)")
				.font(.system(.title3, design: .rounded, weight: .bold))
				.minimumScaleFactor(0.6)
				.widgetCurvesContent()
				.widgetLabel {
					Gauge(value: Double(min(s.needsCount, cornerGaugeCap)), in: 0...Double(cornerGaugeCap)) {
						Text("Needs you")
					}
					.tint(patinaGauge)
				}
				.accessibilityLabel(needsPhrase(s.needsCount))
		case .content:
			Image(systemName: "checkmark").font(.title3.weight(.semibold)).widgetLabel { Text("All clear") }
		case .signedOut:
			Image(systemName: "person.crop.circle").widgetLabel { Text("Sign in") }
		case .unavailable:
			Image(systemName: "wifi.exclamationmark").widgetLabel { Text("Can't refresh") }
		}
	}
}

/// Circular: the top flow's progress as a ring. With no flow it falls back to the count, so the
/// face never shows an empty circle.
private struct CircularView: View {
	let state: WidgetState
	let flow: ComplicationFlow?

	var body: some View {
		if let flow, case .content = state {
			Gauge(value: flow.progress) {
				Text(flow.name)
			} currentValueLabel: {
				Text("\(Int((flow.progress * 100).rounded()))")
					.font(.system(.body, design: .rounded, weight: .semibold))
					.minimumScaleFactor(0.6)
			}
			.gaugeStyle(.accessoryCircularCapacity)
			.tint(flow.paused ? Gradient(colors: [MaskinColor.ruleStrong]) : patinaGauge)
			.accessibilityLabel("\(flow.name), \(Int((flow.progress * 100).rounded())) percent")
		} else {
			fallback
		}
	}

	@ViewBuilder
	private var fallback: some View {
		switch state {
		case .content(let s) where !s.isEmpty:
			Text(s.needsCount > 99 ? "99+" : "\(s.needsCount)")
				.font(.system(.title2, design: .rounded, weight: .bold))
				.minimumScaleFactor(0.6)
				.accessibilityLabel(needsPhrase(s.needsCount))
		case .content:
			Image(systemName: "checkmark").font(.title2.weight(.semibold))
		case .signedOut, .unavailable:
			Image(systemName: "tray").font(.title2)
		}
	}
}

/// Rectangular: "Needs you · Send 7 follow-ups…" over two lines. The title is private, so the
/// system redacts it when the watch is locked.
private struct RectangularView: View {
	let state: WidgetState

	var body: some View {
		switch state {
		case .content(let s) where !s.isEmpty:
			let title = s.top?.title ?? ""
			VStack(alignment: .leading, spacing: 0) {
				(Text("Needs you \u{00B7} ").fontWeight(.semibold) + Text(title))
					.font(.footnote)
					.lineLimit(2)
					.privacySensitive()
				if s.needsCount > 1 {
					Text("+\(s.needsCount - 1) more").font(.caption2).foregroundStyle(.secondary)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.widgetAccentable()
		case .content:
			Text("All clear").font(.footnote.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
		case .signedOut:
			Text("Open Maskin to sign in").font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
		case .unavailable:
			Text("Can't refresh").font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
		}
	}
}

/// Inline: "2 need you".
private struct InlineView: View {
	let state: WidgetState

	var body: some View {
		switch state {
		case .content(let s) where !s.isEmpty: Text(needsPhrase(s.needsCount))
		case .content: Text("All clear")
		case .signedOut: Text("Sign in")
		case .unavailable: Text("Can't refresh")
		}
	}
}
