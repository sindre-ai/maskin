import Foundation
import MaskinCore
import WidgetKit

/// Both widgets share one provider: one fetch policy, one cache.
struct MaskinTimelineProvider: TimelineProvider {
	typealias Entry = MaskinWidgetEntry

	private static var baseURL: URL {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		return raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
	}

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
			let state = await WidgetSnapshotLoader.live(baseURL: Self.baseURL).load()
			completion(Entry(date: now, state: state.resolved(at: now)))
		}
	}

	func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
		nonisolated(unsafe) let completion = completion
		Task {
			let now = Date()
			let state = await WidgetSnapshotLoader.live(baseURL: Self.baseURL).load()
			let plan = WidgetPolicy.plan(for: state, now: now)
			let entries = plan.entries.map { Entry(date: $0, state: state.resolved(at: $0)) }
			completion(Timeline(entries: entries, policy: .after(plan.reloadAfter)))
		}
	}
}
