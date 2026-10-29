import Foundation

/// Turns a message's markdown into one plain line for the chat list: no `[text](url)`, no `**`,
/// no heading marks, list bullets or code fences. The list shows a preview, not a rendering.
public enum ChatPreviewText {
	private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
		// The patterns are constants in this file; a typo is caught by the tests on first run.
		try! NSRegularExpression(pattern: pattern, options: options)
	}

	/// Applied in order. Each is `(pattern, template, options)`.
	private static let linkRules: [(NSRegularExpression, String)] = [
		(regex(#"```[^\n]*\n?"#), ""),  // fence lines, language tag included
		(regex(#"!\[([^\]]*)\]\([^)]*\)"#), "$1"),  // image: keep the alt text
		(regex(#"\[([^\]]+)\]\([^)]*\)"#), "$1"),  // link: keep the words
		// A link the preview cut short: `[words](https://maskin.io/ws/obj` or `[words` at the very end.
		(regex(#"!?\[([^\]\n]*)\]\([^)\n]*\z"#), "$1"),
		(regex(#"!?\[([^\]\n]*)\z"#), "$1"),
		(regex(#"<((?:https?|maskin)://[^>\s]+)>"#), "$1"),  // <autolink>
	]

	/// A bare address the list line shows as the word "link" (see `linePieces`).
	private static let bareAddress = regex(#"<?(?<![\w/])(?:https?|maskin)://[^\s<>]*[^\s<>.,;:!?)\]]>?"#)

	private static let rules: [(NSRegularExpression, String)] = [
		(regex(#"^\s{0,3}#{1,6}\s+"#, .anchorsMatchLines), ""),  // heading marks
		(regex(#"^\s{0,3}>\s?"#, .anchorsMatchLines), ""),  // quote marks
		(regex(#"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?"#, .anchorsMatchLines), ""),  // bullets, numbers, tasks
		(regex(#"^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$"#, .anchorsMatchLines), ""),  // table rule row
		(regex(#"\s*\|\s*"#), " · "),  // table cells
		(regex(#"(?:\s*·\s*){2,}"#), " · "),  // a row's closing pipe next to the next row's opening one
		(regex(#"(\*\*|__)(?=\S)(.+?)(?<=\S)\1"#), "$2"),  // bold
		(regex(#"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])"#), "$1"),  // *italic*
		(regex(#"(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])"#), "$1"),  // _italic_
		(regex(#"~~(.+?)~~"#), "$1"),  // strikethrough
		(regex(#"`([^`\n]+)`"#), "$1"),  // inline code
		(regex(#"\s+"#), " "),  // one line
	]

	public static func plain(_ markdown: String) -> String { render(markdown, addressToken: nil) }

	/// A run of the chat list line. `isLink` runs are the word "link" standing in for a bare address.
	public struct Piece: Equatable, Sendable {
		public var text: String
		public var isLink: Bool
		public init(_ text: String, isLink: Bool = false) {
			self.text = text
			self.isLink = isLink
		}
	}

	private static let addressToken = "\u{E000}"

	/// The chat list line: `plain`, except a bare address becomes the word "link" so the row can draw
	/// it muted. Words of a link cut short by the preview length show as words, not as bracket text.
	public static func linePieces(_ markdown: String) -> [Piece] {
		let text = render(markdown, addressToken: addressToken)
		let runs = text.components(separatedBy: addressToken)
		var pieces: [Piece] = []
		for (i, run) in runs.enumerated() {
			if i > 0 { pieces.append(Piece("link", isLink: true)) }
			if !run.isEmpty { pieces.append(Piece(run)) }
		}
		return pieces
	}

	private static func render(_ markdown: String, addressToken: String?) -> String {
		var text = markdown
		for (rule, template) in linkRules { text = apply(rule, template, to: text) }
		if let addressToken { text = apply(bareAddress, addressToken, to: text) }
		for (rule, template) in rules { text = apply(rule, template, to: text) }
		return text.trimmingCharacters(in: CharacterSet(charactersIn: " ·").union(.whitespacesAndNewlines))
	}

	private static func apply(_ rule: NSRegularExpression, _ template: String, to text: String) -> String {
		rule.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
	}

	/// The first clause of a line, for a one-line flow row: cut at the first `.`, `;`, `:`, `—`
	/// or line break. "Done. PR is up" → "Done"; a text with none of those is returned whole.
	public static func firstClause(_ text: String) -> String {
		let plain = text.trimmingCharacters(in: .whitespacesAndNewlines)
		let stops = CharacterSet(charactersIn: ".;:—\n")
		if let end = plain.unicodeScalars.firstIndex(where: { stops.contains($0) }) {
			let clause = String(plain.unicodeScalars[plain.unicodeScalars.startIndex..<end])
				.trimmingCharacters(in: .whitespacesAndNewlines)
			return clause.isEmpty ? plain : clause
		}
		return plain
	}
}
