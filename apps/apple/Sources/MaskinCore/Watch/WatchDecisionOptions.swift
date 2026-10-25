import Foundation

/// How the watch presents a decision's options. The first screen shows the recommended option, Hold
/// and More; "All options" lists every option the iPhone card has, in the iPhone's order. Pure
/// rules, so they are testable without a view.
public enum WatchDecisionOptions {
	/// Every option, untouched: same set, same order as the iPhone card.
	public static func all(_ options: [DecisionOption]) -> [DecisionOption] { options }

	/// The option the big capsule takes: the one the agent recommends, else the first that is not a
	/// hold.
	public static func primary(_ options: [DecisionOption]) -> DecisionOption? {
		options.first(where: \.recommended) ?? options.first { !isHold($0) }
	}

	/// The card's own Hold option; nil when the agent offered none, so the watch invents no action.
	public static func hold(_ options: [DecisionOption]) -> DecisionOption? {
		options.first(where: isHold)
	}

	/// What "All options" lists above Hold: every option except the holds, in the iPhone's order.
	public static func listed(_ options: [DecisionOption]) -> [DecisionOption] {
		options.filter { !isHold($0) }
	}

	/// Whether "More" has anything the first screen does not already offer.
	public static func hasMore(_ options: [DecisionOption]) -> Bool { listed(options).count > 1 }

	/// The header's place in the pager: "1 of 3".
	public static func position(_ index: Int, of total: Int) -> String { "\(index + 1) of \(total)" }

	/// The reason line under the ask: the first sentence of the summary. A full stop inside a number
	/// ("$2.4k") does not end it.
	public static func reasonLine(_ summary: String) -> String? {
		let text = WatchBriefingText.plain(summary).replacingOccurrences(of: "\n", with: " ")
			.trimmingCharacters(in: .whitespaces)
		guard !text.isEmpty else { return nil }
		let characters = Array(text)
		for (index, character) in characters.enumerated() where ".!?".contains(character) {
			if index + 1 == characters.count || characters[index + 1].isWhitespace {
				return String(characters[...index])
			}
		}
		return text
	}

	/// The offline page's header: "OFFLINE \u{00B7} UPDATED 12 MIN AGO".
	public static func offlineHeader(updatedAt: Date, now: Date) -> String {
		"OFFLINE \u{00B7} \(updatedHeader(updatedAt: updatedAt, now: now))"
	}

	/// "UPDATED 12 MIN AGO", or "UPDATED JUST NOW" inside the first minute.
	public static func updatedHeader(updatedAt: Date, now: Date) -> String {
		let minutes = max(0, Int(now.timeIntervalSince(updatedAt) / 60))
		switch minutes {
		case 0: return "UPDATED JUST NOW"
		case 1..<60: return "UPDATED \(minutes) MIN AGO"
		case 60..<1440: return "UPDATED \(minutes / 60) H AGO"
		default: return "UPDATED \(minutes / 1440) D AGO"
		}
	}

	/// One tap decides, unless the option reaches real people or cannot be taken back (the option's
	/// own `destructive` flag, the same one the iPhone confirm sheet reads).
	public static func needsConfirmation(_ option: DecisionOption) -> Bool { option.destructive }

	/// Hold opens "Why are you holding it?" first.
	public static func isHold(_ option: DecisionOption) -> Bool { HoldReason.isHold(option.label) }

	/// The two reasons offered under Dictate. Skip stores no reason.
	public static let holdPresets = ["Need more time", "Wrong audience"]

	/// The receipt headline: "Send 7 follow-ups" -> "Sent 7", a hold -> "Held". Any other label is
	/// shown as the agent wrote it.
	public static func receiptTitle(for label: String) -> String {
		if HoldReason.isHold(label) { return "Held" }
		let words = label.split(whereSeparator: \.isWhitespace)
		guard let first = words.first, first.lowercased() == "send" else { return label }
		if let number = words.dropFirst().first(where: { $0.allSatisfy(\.isNumber) }) {
			return "Sent \(number)"
		}
		return "Sent"
	}

	/// "Held · your reason: Need more time", or "Held" for a skipped reason.
	public static func heldNote(reason: String?) -> String {
		guard let reason = HoldReason.normalized(reason) else { return "Held" }
		return "Held \u{00B7} your reason: \(reason)"
	}

	/// The confirm screen asks the option as a question: "Approve $2,400?".
	public static func confirmTitle(for label: String) -> String {
		label.hasSuffix("?") ? label : label + "?"
	}
}
