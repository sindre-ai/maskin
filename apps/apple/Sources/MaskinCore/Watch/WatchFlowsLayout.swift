import Foundation

/// How the watch lists flows: one card per page, the daily briefing first, then the flows that need
/// the wearer, then the rest. Each card is a big figure over what it counts, like the iPhone's
/// For you tiles.
public enum WatchFlowsLayout {
	/// One card of the Flows pager.
	public struct Tile: Equatable, Identifiable, Sendable {
		public var id: String
		/// The mono tag at the bottom: "DAILY", "FLOW \u{00B7} SEO".
		public var tag: String
		public var big: String
		public var caption: String
		/// The flow this card opens; nil for the daily briefing, which plays.
		public var flowID: String?

		public var isDaily: Bool { flowID == nil }
	}

	public static let dailyID = "daily"

	/// The daily briefing, then the flows that need the wearer, then the rest; each group A to Z.
	public static func tiles(flows: [WatchSnapshot.Flow], needsCount: Int) -> [Tile] {
		let daily = Tile(
			id: dailyID, tag: "DAILY", big: String(needsCount),
			caption: needsCount == 1 ? "decision needs you" : "decisions need you", flowID: nil)
		let tiles = (needsYou(flows) + onTrack(flows)).map { flow in
			Tile(
				id: flow.id, tag: "FLOW \u{00B7} \(flow.name.uppercased())",
				big: flow.figure ?? percent(flow.progress),
				caption: flow.caption ?? "of the cycle done", flowID: flow.id)
		}
		return [daily] + tiles
	}

	public static func needsYou(_ flows: [WatchSnapshot.Flow]) -> [WatchSnapshot.Flow] {
		flows.filter(\.needsYou).sorted(by: byName)
	}

	public static func onTrack(_ flows: [WatchSnapshot.Flow]) -> [WatchSnapshot.Flow] {
		flows.filter { !$0.needsYou }.sorted(by: byName)
	}

	private static func byName(_ a: WatchSnapshot.Flow, _ b: WatchSnapshot.Flow) -> Bool {
		let order = a.name.localizedStandardCompare(b.name)
		return order == .orderedSame ? a.id < b.id : order == .orderedAscending
	}

	/// The index after moving `delta` pages, wrapping at both ends.
	public static func wrapped(_ index: Int, by delta: Int, count: Int) -> Int {
		guard count > 0 else { return 0 }
		return ((index + delta) % count + count) % count
	}

	/// What a flow's card counts: the decisions waiting on the wearer, else its first target, else
	/// how far the cycle has come.
	public static func figure(
		waiting: Int, target: (actual: String, goal: String, label: String)?, progress: Double
	) -> (big: String, caption: String) {
		if waiting > 0 { return (String(waiting), waiting == 1 ? "decision waits" : "decisions wait") }
		if let target { return ("\(target.actual) of \(target.goal)", target.label.lowercased()) }
		return (percent(progress), "of the cycle done")
	}

	/// The flow's progress as a whole percent: "62%".
	public static func percent(_ progress: Double) -> String { "\(Int((progress * 100).rounded()))%" }

	/// The decision a flow is waiting on: the card about the same object, matched by title. nil when
	/// the flow isn't waiting, or no card names it.
	public static func waitingCard(for flow: WatchSnapshot.Flow, objectTitles: [(id: String, title: String?)]) -> String? {
		guard flow.needsYou else { return nil }
		let name = flow.name.trimmingCharacters(in: .whitespaces).lowercased()
		return objectTitles.first {
			$0.title?.trimmingCharacters(in: .whitespaces).lowercased() == name
		}?.id
	}
}
