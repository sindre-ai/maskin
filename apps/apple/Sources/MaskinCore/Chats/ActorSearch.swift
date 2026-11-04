import Foundation

/// Type-to-find over names, shared by the new-chat sheet and the people pickers. Case and
/// diacritics are ignored. A name that starts with the query ranks first, then one with a word that
/// starts with it, then one that merely contains it; equal ranks keep the order they came in.
public enum ActorSearch {
	/// Lower is better; nil when `name` does not match at all.
	public static func rank(name: String, query: String) -> Int? {
		let needle = fold(query).trimmingCharacters(in: .whitespacesAndNewlines)
		if needle.isEmpty { return 0 }
		let hay = fold(name)
		if hay.hasPrefix(needle) { return 0 }
		let words = hay.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
		if words.contains(where: { $0.hasPrefix(needle) }) { return 1 }
		if hay.contains(needle) { return 2 }
		return nil
	}

	/// The items whose name matches, best matches first. An empty query returns everything as is.
	public static func filter<T>(_ items: [T], query: String, name: (T) -> String) -> [T] {
		let ranked = items.enumerated().compactMap { index, item in
			rank(name: name(item), query: query).map { (rank: $0, index: index, item: item) }
		}
		return ranked.sorted { ($0.rank, $0.index) < ($1.rank, $1.index) }.map(\.item)
	}

	private static func fold(_ text: String) -> String {
		text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
	}
}
