import Foundation

/// How the watch presents a decision's options. Every option the iPhone card has appears, in the
/// iPhone's order; the Digital Crown scrolls the list and `visibleRows` of them fit on screen.
/// Pure rules, so they are testable without a view.
public enum WatchDecisionOptions {
	/// Capsules that fit on a 45 mm screen at once; the rest scroll with the Crown.
	public static let visibleRows = 3

	/// Every option, untouched: same set, same order as the iPhone card.
	public static func all(_ options: [DecisionOption]) -> [DecisionOption] { options }

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

	/// The footer under a decision: how many more wait behind it ("2 MORE \u{00B7} SCROLL"), or
	/// "LAST ONE" when it is the final one.
	public static func remainingLabel(_ remaining: Int) -> String {
		remaining > 0 ? "\(remaining) MORE \u{00B7} SCROLL" : "LAST ONE"
	}

	/// The confirm screen asks the option as a question: "Approve $2,400?".
	public static func confirmTitle(for label: String) -> String {
		label.hasSuffix("?") ? label : label + "?"
	}
}
