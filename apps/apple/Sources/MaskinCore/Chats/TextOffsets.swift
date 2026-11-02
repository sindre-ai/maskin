import Foundation

/// Character offsets for a selection range, without trapping on a stale one.
///
/// A SwiftUI `TextSelection` carries `String.Index` values from whichever text it was made
/// against. By the time `onChange` reads it, the bound text may already be a different string
/// (cleared after a send, replaced by a draft, filled by dictation), and `String.distance(from:to:)`
/// traps on an index that does not belong to the string. That crashed the chat composer on open.
public enum TextOffsets {
	/// `range` as character offsets in `text`, or nil when its indices fall outside `text`.
	public static func characterOffsets(of range: Range<String.Index>, in text: String) -> Range<Int>? {
		// A stale index can sit inside `text`'s bounds yet fall in the middle of a Character (an
		// emoji, a flag, a combining sequence) of the new string. A bounds check alone lets that
		// through and `distance(from:to:)` still traps, so walk the string's own character
		// boundaries and only accept an index that is one of them. Comparing indices never traps.
		guard range.lowerBound <= range.upperBound else { return nil }
		var lower: Int?
		var upper: Int?
		var offset = 0
		var index = text.startIndex
		while true {
			if index == range.lowerBound { lower = offset }
			if index == range.upperBound { upper = offset }
			if index == text.endIndex || (lower != nil && upper != nil) { break }
			index = text.index(after: index)
			offset += 1
		}
		guard let lower, let upper else { return nil }
		return lower..<upper
	}
}
