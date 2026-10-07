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
		guard range.lowerBound >= text.startIndex, range.upperBound <= text.endIndex else { return nil }
		let lower = text.distance(from: text.startIndex, to: range.lowerBound)
		let upper = text.distance(from: text.startIndex, to: range.upperBound)
		return lower <= upper ? lower..<upper : nil
	}
}
