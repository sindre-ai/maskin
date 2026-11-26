import Foundation

/// A question's single text field, split into the question itself and the text it carries (a whole
/// draft, say), so the card can show the question and the options together and cut the rest.
/// The server sends one field, so the split is a client rule:
/// 1. A "?" that ends a sentence with at least `minDetailAfterQuestion` characters after it: the
///    lead runs up to and including it.
/// 2. Else, a text over `longTextLength` characters with a sentence end: the lead is the first sentence.
/// 3. Else no split: the whole text is the lead.
public struct QuestionTextSplit: Equatable, Sendable {
	public let lead: String
	public let detail: String?

	public static let minDetailAfterQuestion = 40
	public static let longTextLength = 140

	public init(_ text: String) {
		let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
		if let end = Self.sentenceEnd(in: text, marks: "\\?"),
			Self.rest(of: text, after: end).count >= Self.minDetailAfterQuestion
		{
			lead = String(text[..<end])
			detail = Self.rest(of: text, after: end)
		} else if text.count > Self.longTextLength, let end = Self.sentenceEnd(in: text, marks: ".!?"),
			!Self.rest(of: text, after: end).isEmpty
		{
			lead = String(text[..<end])
			detail = Self.rest(of: text, after: end)
		} else {
			lead = text
			detail = nil
		}
	}

	/// The index just after the first of `marks` (a regex character class body) that ends a sentence:
	/// followed by whitespace or the end of the text, so a "?" inside a URL does not count.
	private static func sentenceEnd(in text: String, marks: String) -> String.Index? {
		text.range(of: "[\(marks)](?=\\s|$)", options: .regularExpression)?.upperBound
	}

	private static func rest(of text: String, after end: String.Index) -> String {
		text[end...].trimmingCharacters(in: .whitespacesAndNewlines)
	}
}
