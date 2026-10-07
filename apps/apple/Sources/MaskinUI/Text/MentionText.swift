import Foundation
import MaskinDesign
import SwiftUI

/// Turns message text into attributed text with tagged people bold. Pure: give it the text and the
/// names that were tagged (the full names, as `MentionRoster.names(for:)` returns them) and it
/// emboldens each `@FirstName` or `@Full Name`, nothing else. A name that is not in `names` stays
/// plain, so an email address or an `@` that tags no one is left alone.
///
/// Call it wherever message text is shown: a chat bubble, an object-timeline comment, a loop post.
///
///     Text(MentionText.attributed(message.content, names: roster.names(for: message.mentions), style: .ownBubble))
///
/// To highlight inside text that is already attributed (markdown), use `highlight(_:names:style:)`.
public enum MentionText {
	/// Where the text sits, which decides the colour of the tagged name.
	public enum Style: Sendable {
		/// Text on a plain surface or in someone else's bubble: the accent colour.
		case plain
		/// Text in your own (indigo-tinted) bubble: a lighter indigo that reads against it.
		case ownBubble

		public var color: Color {
			switch self {
			case .plain: MaskinColor.accent
			case .ownBubble: MaskinColor.accentFgStrong
			}
		}
	}

	/// The ranges in `text` (as UTF-16 offsets into it) that tag one of `names`, longest name first so
	/// `@Ida Berg` wins over `@Ida`. Matching ignores case and accents, and the tag must be a whole
	/// word: `@Idaho` does not tag Ida.
	public static func ranges(in text: String, names: [String]) -> [Range<String.Index>] {
		let tokens = Set(
			names.flatMap { name -> [String] in
				let first = name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? name
				return [name, first]
			}
		).filter { !$0.isEmpty }.sorted { $0.count > $1.count }
		guard !tokens.isEmpty else { return [] }
		var result: [Range<String.Index>] = []
		var cursor = text.startIndex
		while let at = text[cursor...].firstIndex(of: "@") {
			let afterAt = text.index(after: at)
			let startsWord = at == text.startIndex || !isWordCharacter(text[text.index(before: at)])
			if startsWord {
				for token in tokens {
					guard let end = text.index(afterAt, offsetBy: token.count, limitedBy: text.endIndex),
						text[afterAt..<end].compare(token, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame,
						end == text.endIndex || !isWordCharacter(text[end])
					else { continue }
					result.append(at..<end)
					cursor = end
					break
				}
				if let last = result.last, last.lowerBound == at { continue }
			}
			cursor = afterAt
		}
		return result
	}

	/// The names whose tag does not appear in `text`: tagged people the words do not show (the tag
	/// was edited out, or came from metadata alone). A caption for these is the only record of them.
	public static func untagged(_ names: [String], in text: String) -> [String] {
		names.filter { ranges(in: text, names: [$0]).isEmpty }
	}

	/// Markdown for `MarkdownContent`: each tagged name becomes `[@Name](mention:<actor id>)`, which
	/// the renderer already draws emphasised and never tappable. Use this for message bodies that
	/// are rendered as markdown (chat bubbles); `attributed` is for plain `Text`.
	public static func markdown(_ text: String, mentions: [(id: String, name: String)]) -> String {
		let byToken = mentions.flatMap { m -> [(String, String)] in
			let first = m.name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? m.name
			return [(m.name, m.id), (first, m.id)]
		}
		var out = text
		for range in ranges(in: text, names: mentions.map(\.name)).reversed() {
			let spoken = String(text[range].dropFirst())
			guard let id = byToken.first(where: { $0.0.compare(spoken, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame })?.1
			else { continue }
			out.replaceSubrange(range, with: "[@\(spoken)](\(MarkdownMention.scheme):\(id))")
		}
		return out
	}

	/// `text` with each tagged name bold and in the style's colour.
	public static func attributed(_ text: String, names: [String], style: Style = .plain) -> AttributedString {
		var result = AttributedString(text)
		highlight(&result, names: names, style: style)
		return result
	}

	/// Emboldens tagged names inside text that already carries other attributes. The bold is applied
	/// as an emphasis intent so it composes with the surrounding font instead of replacing it.
	public static func highlight(_ string: inout AttributedString, names: [String], style: Style = .plain) {
		let plain = String(string.characters)
		for range in ranges(in: plain, names: names) {
			let lower = string.index(string.startIndex, offsetByCharacters: plain.distance(from: plain.startIndex, to: range.lowerBound))
			let upper = string.index(string.startIndex, offsetByCharacters: plain.distance(from: plain.startIndex, to: range.upperBound))
			var intent = string[lower..<upper].inlinePresentationIntent ?? []
			intent.insert(.stronglyEmphasized)
			string[lower..<upper].inlinePresentationIntent = intent
			string[lower..<upper].foregroundColor = style.color
		}
	}

	private static func isWordCharacter(_ c: Character) -> Bool { c.isLetter || c.isNumber }
}
