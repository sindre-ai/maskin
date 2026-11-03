import Foundation

/// Slack-style `:name:` emoji. Typing `:tad` offers matches; a complete `:tada:` becomes the emoji
/// when the message is sent.
public enum EmojiShortcodes {
	/// Name and emoji, most-used first: the first rows are also the quick picker's grid.
	public static let table: [(name: String, emoji: String)] = [
		("+1", "👍"), ("heart", "❤️"), ("joy", "😂"), ("tada", "🎉"), ("eyes", "👀"), ("fire", "🔥"),
		("pray", "🙏"), ("rocket", "🚀"), ("white_check_mark", "✅"), ("100", "💯"), ("clap", "👏"),
		("thinking", "🤔"), ("smile", "😄"), ("grinning", "😀"), ("wink", "😉"), ("blush", "😊"),
		("heart_eyes", "😍"), ("sunglasses", "😎"), ("sob", "😭"), ("raised_hands", "🙌"), ("wave", "👋"),
		("ok_hand", "👌"), ("muscle", "💪"), ("sparkles", "✨"), ("star", "⭐"), ("zap", "⚡"),
		("bulb", "💡"), ("warning", "⚠️"), ("x", "❌"), ("question", "❓"), ("bug", "🐛"), ("memo", "📝"),
		("-1", "👎"), ("thumbsup", "👍"), ("thumbsdown", "👎"), ("sweat_smile", "😅"), ("rofl", "🤣"),
		("slightly_smiling", "🙂"), ("upside_down", "🙃"), ("relieved", "😌"), ("innocent", "😇"),
		("smirk", "😏"), ("yum", "😋"), ("kissing_heart", "😘"), ("hug", "🤗"), ("party", "🥳"),
		("pleading", "🥺"), ("salute", "🫡"), ("melting", "🫠"), ("mind_blown", "🤯"), ("nerd", "🤓"),
		("neutral_face", "😐"), ("rolling_eyes", "🙄"), ("confused", "😕"), ("cry", "😢"),
		("angry", "😠"), ("scream", "😱"), ("cold_sweat", "😰"), ("tired", "😫"), ("sleeping", "😴"),
		("hot", "🥵"), ("cold", "🥶"), ("zipper_mouth", "🤐"), ("shrug", "🤷"), ("facepalm", "🤦"),
		("see_no_evil", "🙈"), ("skull", "💀"), ("ghost", "👻"), ("robot", "🤖"), ("poop", "💩"),
		("handshake", "🤝"), ("fingers_crossed", "🤞"), ("point_up", "☝️"), ("brain", "🧠"),
		("blue_heart", "💙"), ("purple_heart", "💜"), ("green_heart", "💚"), ("broken_heart", "💔"),
		("boom", "💥"), ("check", "✔️"), ("no_entry", "⛔"), ("exclamation", "❗"), ("pencil", "✏️"),
		("book", "📖"), ("calendar", "📅"), ("clock", "🕒"), ("hourglass", "⏳"), ("bell", "🔔"),
		("lock", "🔒"), ("key", "🔑"), ("link", "🔗"), ("paperclip", "📎"), ("pushpin", "📌"),
		("mag", "🔍"), ("chart", "📈"), ("chart_down", "📉"), ("money", "💰"), ("gift", "🎁"),
		("trophy", "🏆"), ("medal", "🏅"), ("flag", "🏁"), ("coffee", "☕"), ("pizza", "🍕"), ("beer", "🍺"),
		("cake", "🎂"), ("sun", "☀️"), ("moon", "🌙"), ("cloud", "☁️"), ("snowflake", "❄️"), ("earth", "🌍"),
		("laptop", "💻"), ("phone", "📱"), ("email", "📧"), ("inbox", "📥"), ("package", "📦"),
		("hammer", "🔨"), ("wrench", "🔧"), ("gear", "⚙️"), ("shield", "🛡️"), ("seedling", "🌱"),
		("tree", "🌳"), ("dart", "🎯"), ("puzzle", "🧩"), ("construction", "🚧"), ("arrow_right", "➡️"),
		("arrow_up", "⬆️"), ("recycle", "♻️"), ("repeat", "🔁"), ("new", "🆕"), ("ok", "🆗"), ("sos", "🆘"),
	]

	/// The grid shown by the emoji button.
	public static var popular: [String] {
		var seen = Set<String>()
		return table.prefix(48).map(\.emoji).filter { seen.insert($0).inserted }
	}

	private static let lookup: [String: String] = Dictionary(
		table.map { ($0.name, $0.emoji) }, uniquingKeysWith: { first, _ in first })

	public static func emoji(named name: String) -> String? { lookup[name.lowercased()] }

	/// Matches for what has been typed after the colon: names that start with it first, then names that
	/// contain it; no more than `limit`, one per emoji.
	public static func suggestions(for query: String, limit: Int = 8) -> [(name: String, emoji: String)] {
		let q = query.lowercased()
		guard !q.isEmpty else { return [] }
		let starts = table.filter { $0.name.hasPrefix(q) }
		let contains = table.filter { !$0.name.hasPrefix(q) && $0.name.contains(q) }
		var seen = Set<String>()
		return (starts + contains).filter { seen.insert($0.emoji).inserted }.prefix(limit).map { $0 }
	}

	private static let complete = try! NSRegularExpression(pattern: #"(?<![\w:]):([a-z0-9_+-]{1,32}):(?![\w:])"#)

	/// Turns every complete `:name:` that names an emoji into the emoji. Code (inline or fenced) is left
	/// alone, and so is anything that isn't a known name ("10:30:45", ":notanemoji:").
	public static func expand(_ text: String) -> String {
		guard text.contains(":") else { return text }
		var out = ""
		var inCode = false
		for (index, part) in text.components(separatedBy: "`").enumerated() {
			if index > 0 { out += "`" ; inCode.toggle() }
			guard !inCode else { out += part; continue }
			var result = part
			let matches = complete.matches(in: part, range: NSRange(part.startIndex..., in: part)).reversed()
			for match in matches {
				guard let whole = Range(match.range, in: result), let name = Range(match.range(at: 1), in: result),
					let emoji = emoji(named: String(result[name]))
				else { continue }
				result.replaceSubrange(whole, with: emoji)
			}
			out += result
		}
		return out
	}
}

/// The `:query` being typed at the end of the text, which the emoji picker completes.
public enum EmojiTrigger {
	public struct Match: Equatable {
		public var range: Range<String.Index>
		public var query: String
	}

	public static func find(in text: String) -> Match? {
		guard let colon = text.lastIndex(of: ":") else { return nil }
		if colon > text.startIndex, !text[text.index(before: colon)].isWhitespace { return nil }
		let query = text[text.index(after: colon)...]
		guard query.count >= 2, query.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "_+-".contains($0)) })
		else { return nil }
		return Match(range: colon..<text.endIndex, query: query.lowercased())
	}
}

/// A message turned into a block quote for the composer: the author, then the opening lines.
public enum ChatQuote {
	public static let maxLines = 6
	public static let maxCharacters = 360

	/// Empty when there is no text to quote (a message that is only attachments).
	public static func make(author: String, content: String) -> String {
		var lines: [String] = []
		var used = 0
		var truncated = false
		for raw in content.split(separator: "\n", omittingEmptySubsequences: true) {
			let line = raw.trimmingCharacters(in: .whitespaces)
			if line.isEmpty { continue }
			if lines.count >= maxLines || used + line.count > maxCharacters {
				truncated = true
				break
			}
			lines.append(line)
			used += line.count
		}
		guard !lines.isEmpty else { return "" }
		if truncated { lines[lines.count - 1] += "…" }
		return (["**\(author)**"] + lines).map { "> " + $0 }.joined(separator: "\n") + "\n\n"
	}
}
