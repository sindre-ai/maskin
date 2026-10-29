import Foundation

/// How the watch lists flows: the ones that need the wearer first, the rest folded into one quiet row.
public enum WatchFlowsLayout {
	public static func needsYou(_ flows: [WatchSnapshot.Flow]) -> [WatchSnapshot.Flow] {
		flows.filter(\.needsYou)
	}

	public static func onTrack(_ flows: [WatchSnapshot.Flow]) -> [WatchSnapshot.Flow] {
		flows.filter { !$0.needsYou }
	}

	/// The folded row: "4 more on track" under flows that need you, "4 on track" when none do.
	public static func onTrackLabel(count: Int, othersNeedYou: Bool) -> String {
		othersNeedYou ? "\(count) more on track" : "\(count) on track"
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
