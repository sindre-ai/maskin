import Foundation

/// A person or agent that can be picked in the search field with @.
public struct SearchPerson: Identifiable, Sendable, Equatable, Hashable {
	public var id: String
	public var name: String
	public var isAgent: Bool

	public init(id: String, name: String, isAgent: Bool = false) {
		self.id = id
		self.name = name
		self.isAgent = isAgent
	}
}

/// The "@name" being typed at the end of the search text, and what to do with it. Pure.
public enum SearchMention {
	/// Most people the menu lists at once.
	public static let menuLimit = 8
	/// Most people that can be picked at once (the web allows the same).
	public static let maxPicked = 5

	/// The text after the last "@" when that "@" starts the text or follows a space and nothing
	/// after it is another "@". "launch @product mark" gives "product mark"; "mail@x.com" gives nil.
	public static func fragment(in text: String) -> String? {
		guard let at = text.lastIndex(of: "@") else { return nil }
		if at > text.startIndex, !text[text.index(before: at)].isWhitespace { return nil }
		return String(text[text.index(after: at)...])
	}

	/// People whose name contains the fragment, minus the ones already picked, in name order.
	/// An empty fragment ("@" alone) lists everyone. No match means the "@" stays plain text.
	public static func suggestions(
		for text: String, in people: [SearchPerson], excluding picked: [SearchPerson]
	) -> [SearchPerson] {
		guard let typed = fragment(in: text) else { return [] }
		let pickedIds = Set(picked.map(\.id))
		let needle = typed.trimmingCharacters(in: .whitespaces)
		let hits = people.filter { person in
			!pickedIds.contains(person.id)
				&& (needle.isEmpty || SearchHighlight.matches(needle, in: person.name))
		}
		.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
		return Array(hits.prefix(menuLimit))
	}

	/// The text with the "@fragment" removed, once a person is picked for it.
	public static func removingFragment(from text: String) -> String {
		guard let at = text.lastIndex(of: "@"), fragment(in: text) != nil else { return text }
		return String(text[..<at]).trimmingCharacters(in: .whitespacesAndNewlines)
	}
}
