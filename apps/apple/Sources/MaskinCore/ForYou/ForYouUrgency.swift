import Foundation

/// The one chip a card can carry that says why it sits where it does ("Holding up Forge", "Due
/// 15 Oct", "Asked 2 days ago"). Order is Blocking work now, then Due soon, then When you have a minute.
public struct ForYouUrgency: Equatable, Sendable {
	public enum Kind: Sendable, Equatable { case blocking, due, waiting }

	public var kind: Kind
	public var text: String

	/// 0 blocking, 1 due, 2 waiting, 3 no chip (callers use `rank(of:)` for the last).
	public var rank: Int {
		switch kind {
		case .blocking: 0
		case .due: 1
		case .waiting: 2
		}
	}

	/// Blocking and due are the signal colour; a plain wait is neutral.
	public var isHot: Bool { kind != .waiting }

	public static let noChipRank = 3

	public static func rank(of urgency: ForYouUrgency?) -> Int { urgency?.rank ?? noChipRank }

	/// The chip for a card, or nil. `agent` is the one who raised it, named in "Blocking {agent}".
	/// Only what the data carries: the object's `blocked` status, a "due 15 Oct" in the agent's own
	/// words, and how long the card has waited.
	public static func make(for card: ForYouCard, agent: String?, now: Date = Date()) -> ForYouUrgency? {
		if card.status?.lowercased() == "blocked" {
			return ForYouUrgency(kind: .blocking, text: "Holding up \(agent ?? "work")")
		}
		let text = [card.decision?.summary, card.decision?.ask, card.mention?.content]
			.compactMap { $0 }.joined(separator: " ")
		if let due = dueDate(in: text) { return ForYouUrgency(kind: .due, text: "Due \(due)") }
		if let waited = ForYouFormat.waitingNote(since: card.latestActivityAt, now: now) {
			return ForYouUrgency(kind: .waiting, text: waited)
		}
		return nil
	}

	/// "due 15 Oct" in free text, matched the way the design matches it.
	static func dueDate(in text: String) -> String? {
		guard let range = text.range(of: #"[Dd]ue (\d{1,2} [A-Z][a-z]{2})\b"#, options: .regularExpression)
		else { return nil }
		return String(text[range].dropFirst(4))
	}
}

/// What the reader is triaging by: the kind of ask, not the kind of object.
public enum ForYouIntent: String, Sendable, Codable, CaseIterable {
	/// The agent authored options and wants a call.
	case approvals
	/// A plain mention that needs an answer.
	case questions
	/// The object is blocked on a human.
	case blocking

	public var label: String {
		switch self {
		case .approvals: "Approvals"
		case .questions: "Questions"
		case .blocking: "Blocking"
		}
	}

	public func matches(_ card: ForYouCard, urgency: ForYouUrgency?) -> Bool {
		switch self {
		case .approvals: card.kind == .decision
		case .questions: card.kind == .thread
		case .blocking: urgency?.kind == .blocking
		}
	}
}

public enum ForYouFormat {
	/// The "held 3d" note the widgets show: how long a card that still needs a person has sat.
	/// Nothing is said until it has waited a full day.
	public static func heldNote(since date: Date?, now: Date = Date()) -> String? {
		guard let date else { return nil }
		let days = Int(now.timeIntervalSince(date) / 86_400)
		if days < 1 { return nil }
		if days >= 7 { return "held 7d+" }
		return "held \(days)d"
	}

	/// "Asked 2 days ago": a card that has sat for a full day. Nothing earlier, so a fresh ask has no chip.
	public static func waitingNote(since date: Date?, now: Date = Date()) -> String? {
		guard let date else { return nil }
		let days = Int(now.timeIntervalSince(date) / 86_400)
		if days < 1 { return nil }
		if days >= 7 { return "Asked over a week ago" }
		return days == 1 ? "Asked yesterday" : "Asked \(days) days ago"
	}
}
