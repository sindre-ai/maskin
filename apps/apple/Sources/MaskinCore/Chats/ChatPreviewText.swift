import Foundation

/// Turns a message's markdown into one plain line for the chat list: no `[text](url)`, no `**`,
/// no heading marks, list bullets or code fences. The list shows a preview, not a rendering.
public enum ChatPreviewText {
	private static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
		// The patterns are constants in this file; a typo is caught by the tests on first run.
		try! NSRegularExpression(pattern: pattern, options: options)
	}

	/// Applied in order. Each is `(pattern, template, options)`.
	private static let rules: [(NSRegularExpression, String)] = [
		(regex(#"```[^\n]*\n?"#), ""),  // fence lines, language tag included
		(regex(#"!\[([^\]]*)\]\([^)]*\)"#), "$1"),  // image: keep the alt text
		(regex(#"\[([^\]]+)\]\([^)]*\)"#), "$1"),  // link: keep the words
		(regex(#"<((?:https?|maskin)://[^>\s]+)>"#), "$1"),  // <autolink>
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

	public static func plain(_ markdown: String) -> String {
		var text = markdown
		for (rule, template) in rules {
			let range = NSRange(text.startIndex..., in: text)
			text = rule.stringByReplacingMatches(in: text, range: range, withTemplate: template)
		}
		return text.trimmingCharacters(in: CharacterSet(charactersIn: " ·").union(.whitespacesAndNewlines))
	}
}
