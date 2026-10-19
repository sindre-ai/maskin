import Foundation

/// Pure helpers for showing why a result matched: where the query occurs, and a window of text
/// around the first occurrence.
public enum SearchHighlight {
	static let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]

	/// Every non-overlapping occurrence of `query` in `text`, case and diacritic insensitive.
	public static func ranges(of query: String, in text: String) -> [Range<String.Index>] {
		let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !needle.isEmpty else { return [] }
		var found: [Range<String.Index>] = []
		var from = text.startIndex
		while from < text.endIndex,
			let range = text.range(of: needle, options: options, range: from..<text.endIndex)
		{
			found.append(range)
			from = range.upperBound
		}
		return found
	}

	public static func matches(_ query: String, in text: String) -> Bool {
		let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
		return needle.isEmpty || text.range(of: needle, options: options) != nil
	}

	/// One line of `text` centred on the first match (ellipsised when cut), whitespace collapsed.
	/// Without a match it is the start of the text.
	public static func snippet(of text: String, around query: String, radius: Int = 60) -> String {
		let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
			.trimmingCharacters(in: .whitespaces)
		guard let match = ranges(of: query, in: flat).first else {
			return flat.count > radius * 2 ? String(flat.prefix(radius * 2)) + "…" : flat
		}
		let start = flat.index(match.lowerBound, offsetBy: -radius, limitedBy: flat.startIndex) ?? flat.startIndex
		let end = flat.index(match.upperBound, offsetBy: radius, limitedBy: flat.endIndex) ?? flat.endIndex
		return (start > flat.startIndex ? "…" : "") + flat[start..<end] + (end < flat.endIndex ? "…" : "")
	}
}
