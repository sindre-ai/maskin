import Foundation

/// "Hold" is an option label the agent authors, not a special action. A hold asks the reader for a
/// reason first ("Why are you holding it?"); the reason is optional and travels with the option in
/// the same comment, so the timeline shows why.
public enum HoldReason {
	/// The one-tap reasons under the text field, from the design.
	public static let presets = [
		"Not until the Acme call on Thursday",
		"I need the numbers first",
		"Not this cycle \u{2014} it can wait",
		"I don\u{2019}t agree with the recommendation",
	]

	/// Whether an option label is a hold ("Hold", "Hold for now"). A plain word match: an option
	/// merely containing "hold" ("Withhold payment") is not one.
	public static func isHold(_ label: String) -> Bool {
		let first = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
			.split(whereSeparator: { !$0.isLetter }).first
		return first == "hold"
	}

	/// The reason as it is stored: trimmed, nil when empty (Skip).
	public static func normalized(_ text: String?) -> String? {
		let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? nil : trimmed
	}

	/// The grey note on a decided card: "Held \u{00B7} your reason: ...", or "none given".
	public static func note(for reason: String?) -> String {
		"Held \u{00B7} your reason: \(normalized(reason) ?? "none given")"
	}

	/// The sheet's subtitle: who waits rather than guessing.
	public static func subtitle(agent: String?) -> String {
		let who = agent.flatMap { normalized($0) } ?? "The agent"
		return "\(who) waits rather than guessing. One sentence is enough \u{2014} it goes on the timeline."
	}
}
