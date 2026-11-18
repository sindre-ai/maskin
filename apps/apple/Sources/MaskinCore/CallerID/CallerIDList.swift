import Foundation

/// One number the phone should put a name to, in the form Apple's call directory takes: the
/// digits with the country code first and no "+". Names only, for incoming calls.
public struct CallerIDEntry: Codable, Sendable, Equatable, Hashable {
	public var number: Int64
	public var label: String

	public init(number: Int64, label: String) {
		self.number = number
		self.label = label
	}
}

/// Turns what a contact holds in its phone field into a number the phone can use.
public enum CallerIDNumber {
	/// The text before the first "(" (a note like "(where we found it)"), with whitespace and dashes
	/// removed. "+" then 8 to 15 digits is kept; "0045" becomes "+45"; exactly 8 digits get "+45".
	/// Anything else is nil, so the contact is skipped.
	public static func normalize(_ raw: String) -> Int64? {
		var text = String(raw.prefix { $0 != "(" }.filter { !$0.isWhitespace && $0 != "-" })
		if text.hasPrefix("0045") {
			text = "+45" + String(text.dropFirst(4))
		} else if text.count == 8, text.allSatisfy(isDigit) {
			text = "+45" + text
		}
		guard text.hasPrefix("+") else { return nil }
		let digits = text.dropFirst()
		guard (8...15).contains(digits.count), digits.allSatisfy(isDigit) else { return nil }
		return Int64(digits)
	}

	private static func isDigit(_ character: Character) -> Bool { ("0"..."9").contains(character) }
}

/// Builds the list the phone loads from the workspace contacts.
public enum CallerIDListBuilder {
	/// Titles that start like this are placeholders made from inbound calls: no real name to show.
	static let placeholderPrefix = "unknown caller"

	/// One entry per number, sorted ascending by number (the phone rejects anything else).
	/// Placeholder and nameless contacts are skipped. When two contacts share a number the most
	/// recently updated one wins, then the lower id, so the same contacts always give the same list.
	public static func build(from contacts: [WorkObject]) -> [CallerIDEntry] {
		var chosen: [Int64: (contact: WorkObject, label: String)] = [:]
		for contact in contacts {
			guard let label = label(of: contact),
				let raw = contact.metadata["phone"],
				let number = CallerIDNumber.normalize(raw)
			else { continue }
			if let current = chosen[number], !wins(contact, over: current.contact) { continue }
			chosen[number] = (contact, label)
		}
		return chosen.map { CallerIDEntry(number: $0.key, label: $0.value.label) }
			.sorted { $0.number < $1.number }
	}

	private static func label(of contact: WorkObject) -> String? {
		let label = (contact.title ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
		guard !label.isEmpty, !label.lowercased().hasPrefix(placeholderPrefix) else { return nil }
		return label
	}

	private static func wins(_ candidate: WorkObject, over current: WorkObject) -> Bool {
		let candidateUpdated = candidate.updatedAt ?? .distantPast
		let currentUpdated = current.updatedAt ?? .distantPast
		if candidateUpdated != currentUpdated { return candidateUpdated > currentUpdated }
		return candidate.id < current.id
	}
}
