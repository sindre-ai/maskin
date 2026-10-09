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

	/// How a status is drawn, which comes from its category (`StatusCategory` in MaskinCore, handoff
	/// 1E), never its name: Patina for what is under way or wants the person, grey for backlog and
	/// cancelled, ink for done. Never green, amber or blue. MaskinUI cannot see MaskinCore, so the
	/// key sets here mirror its table; `StatusCategoryVisualsTests` keeps the two in step.
	public enum Tone: Sendable, Equatable { case grey, patina, ink }

	static let patinaKeys: Set<String> = [
		"in_progress", "active", "live", "processing", "clustered", "in_review", "waiting_for_input",
		"blocked", "started",
	]
	static let inkKeys: Set<String> = ["done", "completed", "validated", "succeeded", "scored", "paid"]
	/// Failure and risk read in the warning colour (the one allowed non-Patina signal), on a grey fill.
	static let alertKeys: Set<String> = ["failed", "at_risk", "breached"]

	/// The tone of a status key (after aliases). Unknown keys are grey.
	public static func tone(for status: String) -> Tone {
		if patinaKeys.contains(status) { return .patina }
		let key = aliases[status] ?? status
		if patinaKeys.contains(key) { return .patina }
		if inkKeys.contains(key) { return .ink }
		return .grey
	}

	public static let alert = MaskinColorPair(bg: MaskinColor.surfaceAlt, fg: MaskinColor.warningStrong)
	public static let patina = MaskinColorPair(bg: MaskinColor.sigTint, fg: MaskinColor.sigInk)
	public static let done = MaskinColorPair(bg: MaskinColor.doneBg, fg: MaskinColor.doneFg)

	public static func colors(for status: String) -> MaskinColorPair {
		let key = aliases[status] ?? status
		if alertKeys.contains(key), !patinaKeys.contains(status) {
			return alert
		}
		switch tone(for: status) {
		case .patina: return patina
		case .ink: return done
		case .grey: return fallback
		}
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
/// Type tags are neutral; only the type DOT keeps its hue (the documented colour exception).
public enum MaskinObjectType {
	public static let fallback = MaskinColorPair(bg: MaskinColor.surfaceAlt, fg: MaskinColor.ink3)

	/// The hue of a type's dot: Doc, Insight, Bet and Task keep theirs; other types are grey.
	public static func dotColor(for type: String) -> Color {
		switch type {
		case "doc", "document", "knowledge": MaskinColor.objDoc
		case "insight": MaskinColor.objInsight
		case "bet": MaskinColor.objBet
		case "task": MaskinColor.objTask
		default: MaskinColor.ink5
		}
	}

	public static func tokenKey(for type: String) -> String? {
		MaskinTypePalette.all[type] != nil ? type : nil
	}

	public static func colors(for type: String) -> MaskinColorPair {
		fallback
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
