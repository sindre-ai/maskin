import MaskinDesign
import SwiftUI

/// The pure rules for an object chip inside a sentence: the short name it shows and the status dot
/// that follows it (native spec, Chip).
public enum MarkdownChip {
	/// Titles longer than this are cut.
	static let nameLimit = 90
	/// A cut lands on a space only if that space is past this point; otherwise it cuts at the limit.
	static let nameFloor = 60

	/// What a chip calls an object. Only the text before a long dash with a space each side shows
	/// ("David Harboe — Norlix (CTO)" is "David Harboe"); a title over 90 characters is cut at the last
	/// space before 90 if that is past 60, and ends with an ellipsis. The full title is in the sheet.
	public static func shortName(_ title: String) -> String {
		var name = title.trimmingCharacters(in: .whitespacesAndNewlines)
		if let dash = name.range(of: " \u{2014} ") {
			let before = name[..<dash.lowerBound].trimmingCharacters(in: .whitespaces)
			if !before.isEmpty { name = before }
		}
		guard name.count > nameLimit else { return name }
		let head = String(name.prefix(nameLimit))
		var cut = head
		if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) > nameFloor {
			cut = String(head[..<space])
		}
		return cut.trimmingCharacters(in: .whitespaces) + "\u{2026}"
	}

	/// The colour family of the dot after the name.
	public enum StatusDot: Sendable, Equatable { case patina, ink, warning, grey }

	/// Patina for what is under way, ink for done, warning for failed and at risk, grey for the rest.
	/// Nil when the object has no status: no dot.
	public static func statusDot(for status: String?) -> StatusDot? {
		guard let status = status?.trimmingCharacters(in: .whitespaces), !status.isEmpty else { return nil }
		let key = MaskinStatus.aliases[status] ?? status
		if MaskinStatus.alertKeys.contains(key), !MaskinStatus.patinaKeys.contains(status) { return .warning }
		switch MaskinStatus.tone(for: status) {
		case .patina: return .patina
		case .ink: return .ink
		case .grey: return .grey
		}
	}

	static func color(of dot: StatusDot) -> Color {
		switch dot {
		case .patina: MaskinStatus.patina.fg
		case .ink: MaskinStatus.done.fg
		case .warning: MaskinStatus.alert.fg
		case .grey: MaskinColor.ink5
		}
	}
}
