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
	/// The card's footer message, specific to the decision: "Decide: <title>" for one, "3 decisions
	/// waiting: <title>" for several, naming the newest unanswered one. Without a title it counts
	/// only ("1 decision waits on you"). Nil when none wait on the viewer.
	public static func banner(_ loop: LoopSummary, decisionTitle: String? = nil) -> String? {
		guard loop.status.isLive, loop.waitingCount > 0 else { return nil }
		let n = loop.waitingCount
		let title = decisionTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let title, !title.isEmpty else {
			return n == 1 ? "1 decision waits on you" : "\(n) decisions wait on you"
		}
		return n == 1 ? "Decide: \(title)" : "\(n) decisions waiting: \(title)"
	}

	/// What a decision post is called: its own title, else the first sentence of its text.
	public static func decisionTitle(from post: LoopPost?) -> String? {
		guard let post, post.isDecision else { return nil }
		if let title = post.decisionTitle, !title.isEmpty { return title }
		let text = LoopLatestUpdate.sentence(from: post.text, limit: LoopLatestUpdate.cardLimit)
		return text.isEmpty ? nil : text
	}

	/// The one sentence under the Flows title: "2 of 4 flows need you.", or "Nothing needs you." when
	/// no running flow waits on the viewer. Nil without flows.
	public static func needsYouLine(_ loops: [LoopSummary]) -> String? {
		guard !loops.isEmpty else { return nil }
		let needing = loops.filter { $0.status.isLive && ($0.pill == .waitingOnYou || $0.waitingCount > 0) }.count
		guard needing > 0 else { return "Nothing needs you." }
		return "\(needing) of \(loops.count) \(loops.count == 1 ? "flow needs" : "flows need") you."
	}

	/// "2 in progress · 5 closed" under a card's figure; nil when the flow has no work yet.
	public static func workLine(_ loop: LoopSummary) -> String? {
		var parts: [String] = []
		if loop.inProgressCount > 0 { parts.append("\(loop.inProgressCount) in progress") }
		if loop.closedCount > 0 { parts.append("\(loop.closedCount) closed") }
		return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
