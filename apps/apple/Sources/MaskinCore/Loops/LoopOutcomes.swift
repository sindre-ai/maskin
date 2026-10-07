import Foundation

/// How an outcome is doing, as the score cards show it. Urgency is shade, not hue.
public enum OutcomeStatus: Sendable, Equatable, CaseIterable {
	case needsYou, atRisk, watch, onTrack

	public var label: String {
		switch self {
		case .needsYou: "Needs you"
		case .atRisk: "At risk"
		case .watch: "Watch"
		case .onTrack: "On track"
		}
	}

	/// Most urgent first.
	var urgency: Int {
		switch self {
		case .needsYou: 0
		case .atRisk: 1
		case .watch: 2
		case .onTrack: 3
		}
	}
}

/// A loop target with its derived status, ready for a card.
public struct OutcomeCard: Identifiable, Equatable, Sendable {
	public var loopID: String
	public var loopName: String
	public var target: LoopTarget
	public var status: OutcomeStatus
	public var id: String { "\(loopID)#\(target.label)" }
}

/// Status of a target, from actual vs goal. Mirrors the web's pace verdict
/// (`components/loops/target-card.tsx`) and folds its four labels into the iOS four:
/// Missed and Behind pace under half the goal are "At risk", Behind pace from half up is "Watch",
/// On / Above target are "On track". A loop waiting on the viewer is "Needs you".
public enum LoopOutcomes {
	/// Under this share of the goal, behind pace reads as at risk rather than watch.
	static let watchFloor = 0.5

	public static func status(of target: LoopTarget, waitingOnYou: Bool = false) -> OutcomeStatus {
		if waitingOnYou { return .needsYou }
		let goal = target.target, actual = target.actual
		if goal > 0 && actual <= 0 { return .atRisk }
		let ratio = goal != 0 ? actual / goal : (actual > 0 ? 1 : 0)
		if ratio >= (target.isStrict ? 1 : 0.9) { return .onTrack }
		return ratio >= watchFloor ? .watch : .atRisk
	}

	/// The loop's targets as cards; empty when it has none.
	public static func cards(for loop: LoopSummary) -> [OutcomeCard] {
		let waiting = loop.pill == .waitingOnYou
		return (loop.targets ?? []).map {
			OutcomeCard(
				loopID: loop.id, loopName: loop.displayName, target: $0,
				status: status(of: $0, waitingOnYou: waiting))
		}
	}

	/// Every target across the loops, most urgent first (list order within a status). Empty when
	/// no loop has targets, which hides the row.
	public static func cards(for loops: [LoopSummary]) -> [OutcomeCard] {
		loops.flatMap { cards(for: $0) }
			.enumerated()
			.sorted {
				$0.element.status.urgency != $1.element.status.urgency
					? $0.element.status.urgency < $1.element.status.urgency : $0.offset < $1.offset
			}
			.map(\.element)
	}
}

/// The real numbers the API has for a loop's health row.
public enum LoopQuality {
	public struct Stat: Identifiable, Equatable, Sendable {
		public var label: String
		public var value: String
		public var id: String { label }
	}

	/// In progress, closed, median time to close, waiting, next run. `nextRun` comes from the
	/// loop's steps (`LoopComingUp`); nil shows a dash. `duration` and `date` render the values.
	public static func stats(
		for loop: LoopSummary, nextRun: Date?, duration: (TimeInterval) -> String,
		date: (Date) -> String
	) -> [Stat] {
		[
			Stat(label: "In progress", value: "\(loop.inProgressCount)"),
			Stat(label: "Closed", value: "\(loop.closedCount)"),
			Stat(label: "Median time", value: loop.medianTimeToClose.map(duration) ?? "—"),
			Stat(label: "Needs you", value: "\(loop.waitingCount)"),
			Stat(label: "Next run", value: nextRun.map(date) ?? "—"),
		]
	}

	/// The three labels the Outcome tab's QUALITY cards show, in order.
	public static let cardLabels = ["Closed", "Median time", "Next run"]

	/// `stats` narrowed to the three quality cards.
	public static func cardStats(
		for loop: LoopSummary, nextRun: Date?, duration: (TimeInterval) -> String,
		date: (Date) -> String
	) -> [Stat] {
		let all = stats(for: loop, nextRun: nextRun, duration: duration, date: date)
		return cardLabels.compactMap { label in all.first { $0.label == label } }
	}

	/// When the loop next runs on its own: the earliest scheduled step; nil if paused or event-only.
	public static func nextRun(steps: [LoopStep], now: Date, paused: Bool) -> Date? {
		LoopComingUp.items(steps: steps, now: now, paused: paused).compactMap(\.next).min()
	}
}
