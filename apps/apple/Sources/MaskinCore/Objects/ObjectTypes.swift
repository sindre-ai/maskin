import Foundation

/// Order, plural labels and glyphs for object types. Types come from the workspace schema; this
/// only decides how the ones present are arranged (handoff 8-Objects), never which exist.
public enum ObjectTypeOrder {
	/// The prototype's order when present; anything else follows alphabetically by key.
	static let preferred = [
		"bet", "insight", "task", "knowledge", "doc", "person", "company", "article", "meeting",
	]

	/// "Account" in older data is a Company.
	public static func canonical(_ type: String) -> String {
		let key = type.lowercased()
		return key == "account" ? "company" : key
	}

	public static func sorted(_ types: [String]) -> [String] {
		func rank(_ type: String) -> Int {
			preferred.firstIndex(of: canonical(type)) ?? preferred.count
		}
		return types.sorted { a, b in
			let (ra, rb) = (rank(a), rank(b))
			return ra != rb ? ra < rb : a.localizedStandardCompare(b) == .orderedAscending
		}
	}

	/// "Insight" -> "Insights", "Person" -> "People", "Company" -> "Companies", "Knowledge" stays.
	public static func plural(_ name: String) -> String {
		let lower = name.lowercased()
		if lower == "knowledge" || lower.hasSuffix("s") { return name }
		if lower == "person" { return name.hasPrefix("P") ? "People" : "people" }
		if lower.hasSuffix("y"), let before = lower.dropLast().last, !"aeiou".contains(before) {
			return String(name.dropLast()) + "ies"
		}
		if lower.hasSuffix("ch") || lower.hasSuffix("sh") || lower.hasSuffix("x") { return name + "es" }
		return name + "s"
	}

	/// SF Symbol for a type's glyph; `square` for an unknown one.
	public static func symbol(for type: String) -> String {
		switch canonical(type) {
		case "bet": "hexagon"
		case "insight": "lightbulb"
		case "task": "checkmark.square"
		case "knowledge": "book.closed"
		case "doc": "doc.text"
		case "person": "person"
		case "company": "building.2"
		case "article": "newspaper"
		case "meeting": "calendar"
		default: "square"
		}
	}
}

/// The Objects tab's top-level choice: what needs you, everything, or one type.
public enum ObjectsTab: Hashable, Sendable {
	case needsYou
	case all
	case type(String)
}
