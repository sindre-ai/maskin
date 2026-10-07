import MaskinDesign
import SwiftUI

/// Maps an object/session status string to its badge colours and label, mirroring
/// `statusColors` / `statusLabel` in `apps/web/src/lib/constants.ts`.
public enum MaskinStatus {
	/// Statuses that borrow another status's colours (web `statusColors` aliases).
	static let aliases: [String: String] = [
		"at-risk": "at_risk",
		"queued": "processing",
		"pending": "processing",
		"starting": "processing",
		"snapshotting": "processing",
		"running": "active",
		"waiting_for_input": "blocked",
		"timeout": "failed",
		"paid": "succeeded",
		"inactive": "parked",
		"past_due": "at_risk",
		"declined": "failed",
		"canceled": "discarded",
	]

	/// Neutral pair for statuses the product does not know (workspace-custom statuses).
	public static let fallback = MaskinColorPair(bg: MaskinColor.surfaceAlt, fg: MaskinColor.ink4)

	/// The token key a status resolves to, or nil when it has no dedicated colours.
	public static func tokenKey(for status: String) -> String? {
		let key = aliases[status] ?? status
		return MaskinStatusPalette.all[key] != nil ? key : nil
	}

	/// v4 brand rule: done is ink on a neutral fill (with a check glyph at the call site), never
	/// green. The generated palette still carries the web's green pair for these keys, so the
	/// native clients override them here.
	static let doneKeys: Set<String> = ["done", "completed", "succeeded"]
	public static let done = MaskinColorPair(bg: MaskinColor.doneBg, fg: MaskinColor.doneFg)

	public static func colors(for status: String) -> MaskinColorPair {
		guard let key = tokenKey(for: status) else { return fallback }
		if doneKeys.contains(key) { return done }
		return MaskinStatusPalette.all[key] ?? fallback
	}

	/// Human label: "in_progress" → "in progress", with the product's special cases.
	public static func label(for status: String) -> String {
		switch status {
		case "todo": "To do"
		case "in_progress": "In progress"
		case "in_review": "In review"
		case "waiting_for_input": "Needs you"
		default: status.replacingOccurrences(of: "_", with: " ")
		}
	}

	/// Sentence-cased label for the bare-word presentation ("Blocked", "In review").
	public static func sentenceLabel(for status: String) -> String {
		let label = label(for: status)
		return label.prefix(1).uppercased() + label.dropFirst()
	}
}

/// Maps an object type to badge colours and an SF Symbol, mirroring `typeColors` / `typeIcons`.
public enum MaskinObjectType {
	public static let fallback = MaskinColorPair(bg: MaskinColor.surfaceAlt, fg: MaskinColor.ink4)

	public static func tokenKey(for type: String) -> String? {
		MaskinTypePalette.all[type] != nil ? type : nil
	}

	public static func colors(for type: String) -> MaskinColorPair {
		MaskinTypePalette.all[type] ?? fallback
	}

	/// SF Symbol for built-in types; nil for module / custom types (callers show an initial).
	public static func symbol(for type: String) -> String? {
		switch type {
		case "insight": "lightbulb"
		case "bet": "scope"
		case "task": "checkmark.square"
		case "file": "doc.text"
		case "conversation": "bubble.left"
		case "session": "shippingbox"
		default: nil
		}
	}
}
