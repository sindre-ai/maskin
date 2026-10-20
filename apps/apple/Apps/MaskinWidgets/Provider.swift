import Foundation
import MaskinCore
import WidgetKit

/// Both widgets share one provider: one fetch policy, one cache.
struct MaskinTimelineProvider: TimelineProvider {
	typealias Entry = MaskinWidgetEntry

	private static var baseURL: URL { WidgetRuntime.baseURL }

	func placeholder(in context: Context) -> Entry {
		Entry(date: Date(), state: .content(.sample()))
	}

	func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
		// The gallery asks for a preview: invented data, no network, no Keychain.
		if context.isPreview {
			completion(Entry(date: Date(), state: .content(.sample())))
			return
		}
		nonisolated(unsafe) let completion = completion
		Task {
			let now = Date()
			let (state, chosen) = await Self.load(at: now)
			completion(Entry(date: now, state: state.resolved(at: now), chosen: chosen))
		}
	}

	func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
		nonisolated(unsafe) let completion = completion
		Task {
			let now = Date()
			let (state, chosen) = await Self.load(at: now)
			let plan = WidgetPolicy.plan(for: state, now: now)
			let entries = plan.entries.map { Entry(date: $0, state: state.resolved(at: $0), chosen: chosen) }
			completion(Timeline(entries: entries, policy: .after(plan.reloadAfter)))
		}
	}

	/// The snapshot with this reader's own widget answers applied: an answer left unsent by a
	/// killed process goes out first, answered decisions drop off the list, and the newest answer
	/// is handed to the medium widget for its "You chose" card.
	private static func load(at now: Date) async -> (WidgetState, WidgetDecisionRecord?) {
		let decisions = WidgetRuntime.decisions()
		await decisions.flushDue()
		let state = await WidgetSnapshotLoader.live(baseURL: baseURL).load()
		let shown = decisions.shown(at: now)
		return (state.applying(shown), shown.first)
	}
}
