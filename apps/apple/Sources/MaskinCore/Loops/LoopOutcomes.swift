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

	/// Every real number the API has for a loop's health: in progress, closed, median time to close,
	/// waiting, next run. Dashes for what is missing.
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

	/// The five tiles at the top of a flow's Setup tab, worded and formatted as web writes them:
	/// cycles running (only while the flow is live), closed, median cycle time, asks waiting and the
	/// next fire. A dash for what is missing.
	public static func setupStats(for loop: LoopSummary, nextRun: Date?, now: Date) -> [Stat] {
		[
			Stat(label: "Cycles running", value: "\(loop.pill.isLive ? loop.inProgressCount : 0)"),
			Stat(label: "Closed this month", value: "\(loop.closedCount)"),
			Stat(label: "Median cycle time", value: loop.medianTimeToClose.flatMap(shortDuration) ?? "—"),
			Stat(label: "Asks waiting", value: "\(loop.waitingCount)"),
			Stat(label: "Next fire", value: nextRun.flatMap { nextFireLabel($0, now: now) } ?? "—"),
		]
	}

	/// "12d", "3h", "9m", "45s": one unit, rounded. Nil for nothing to show yet.
	static func shortDuration(_ seconds: TimeInterval) -> String? {
		guard seconds.isFinite, seconds > 0 else { return nil }
		let minutes = seconds / 60, hours = minutes / 60, days = hours / 24
		if days >= 1 { return "\(Int(days.rounded()))d" }
		if hours >= 1 { return "\(Int(hours.rounded()))h" }
		if minutes >= 1 { return "\(Int(minutes.rounded()))m" }
		return "\(Int(seconds.rounded()))s"
	}

	/// "in 4m", "in 3h", "in 2d", or a short date a week or more out. Nil when it is not in the future.
	static func nextFireLabel(_ at: Date, now: Date) -> String? {
		let seconds = at.timeIntervalSince(now)
		guard seconds > 0 else { return nil }
		let minutes = Int((seconds / 60).rounded())
		if minutes < 60 { return "in \(minutes)m" }
		let hours = Int((seconds / 3600).rounded())
		if hours < 24 { return "in \(hours)h" }
		let days = Int((seconds / 86400).rounded())
		if days < 7 { return "in \(days)d" }
		return at.formatted(.dateTime.month(.abbreviated).day())
	}

	/// When the loop next runs on its own: the earliest scheduled step; nil if paused or event-only.
	public static func nextRun(steps: [LoopStep], now: Date, paused: Bool) -> Date? {
		LoopComingUp.items(steps: steps, now: now, paused: paused).compactMap(\.next).min()
	}
}
