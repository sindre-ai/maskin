import Foundation

/// The three stages a running flow moves through, as the Status pill and Setup chips name them.
public enum LoopStage: CaseIterable, Sendable, Equatable {
	case learning, supervised, autonomous

	public var title: String {
		switch self {
		case .learning: "Learning"
		case .supervised: "Supervised"
		case .autonomous: "Autonomous"
		}
	}

	/// The one line under the chips.
	public var note: String {
		switch self {
		case .learning: "Agents ask before every action."
		case .supervised: "Agents act inside guardrails and ask on the rest."
		case .autonomous: "Agents act and report."
		}
	}

	public var status: LoopPill {
		switch self {
		case .learning: .learning
		case .supervised: .supervised
		case .autonomous: .fullyAutonomous
		}
	}

	/// The stage of a running flow; nil for a draft or a paused flow.
	public init?(status: LoopPill) {
		switch status {
		case .learning: self = .learning
		case .supervised: self = .supervised
		case .fullyAutonomous: self = .autonomous
		case .draft, .paused, .waitingOnYou: return nil
		}
	}
}

public enum FlowTags {
	/// Every distinct tag (case-insensitive), A to Z, blanks dropped.
	public static func all(_ loops: [LoopSummary]) -> [String] {
		var seen = Set<String>()
		var result: [String] = []
		for tag in loops.flatMap({ $0.tags ?? [] }) {
			let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines)
			if !trimmed.isEmpty, seen.insert(trimmed.lowercased()).inserted { result.append(trimmed) }
		}
		return result.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
	}

	public static func has(_ loop: LoopSummary, _ tag: String) -> Bool {
		(loop.tags ?? []).contains { $0.caseInsensitiveCompare(tag) == .orderedSame }
	}
}

/// What the Flows list and its cards say, worked out from the loops alone.
public enum FlowsOverview {
	/// "2 of 4 flows need you." / "Nothing needs you right now." Nil with no flows. The mockup adds
	/// one clause per flow naming the ask; the API has no per-flow ask text, so it is left out.
	public static func lead(_ loops: [LoopSummary]) -> String? {
		guard !loops.isEmpty else { return nil }
		let needing = loops.filter { $0.status.isLive && ($0.pill == .waitingOnYou || $0.waitingCount > 0) }.count
		if needing == 0 { return "Nothing needs you right now." }
		let total = loops.count
		if total == 1 { return "1 flow needs you." }
		return "\(needing) of \(total) flow\(total == 1 ? "" : "s") \(needing == 1 ? "needs" : "need") you."
	}

	/// The card's footer message: how many decisions wait on the viewer. Nil when none do.
	public static func banner(_ loop: LoopSummary) -> String? {
		guard loop.status.isLive, loop.waitingCount > 0 else { return nil }
		let n = loop.waitingCount
		return n == 1 ? "1 decision waits on you" : "\(n) decisions wait on you"
	}

	/// The status word beside the dot: Needs you, or the stage / Paused / Draft.
	public static func statusWord(_ loop: LoopSummary) -> String { loop.pill.label }

	/// The card's headline figures, from the flow's most urgent target. Nil without a target, which
	/// hides the metric, label and bar. No pace line or "should be here today" marker: the API has
	/// no due date or rate to compute them from.
	public static func figures(_ loop: LoopSummary) -> Figures? {
		guard let card = LoopOutcomes.cards(for: loop).sorted(by: { $0.status.urgency < $1.status.urgency }).first
		else { return nil }
		return Figures(
			value: "\(format(card.target.actual)) of \(format(card.target.target))",
			label: card.target.label, fraction: card.target.fraction, status: card.status)
	}

	public struct Figures: Equatable, Sendable {
		public var value: String
		public var label: String
		public var fraction: Double
		public var status: OutcomeStatus
	}

	static func format(_ value: Double) -> String {
		value.formatted(.number.precision(.fractionLength(0...1)))
	}
}

/// How a target's `source` reads on a card.
public enum FlowTargetSource {
	/// The source as words, or nil when it is a machine id (`metric:tasks.merged`, `event:x`) or
	/// blank: ids are never shown as labels.
	public static func label(_ source: String?) -> String? {
		guard let text = source?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
		let lower = text.lowercased()
		if lower.hasPrefix("metric:") || lower.hasPrefix("event:") { return nil }
		return text
	}
}
