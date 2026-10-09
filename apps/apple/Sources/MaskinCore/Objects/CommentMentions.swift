import Foundation

/// `@name` tagging in an object comment. Unlike chat (where a pick becomes a chip), the comment
/// keeps `@Name` in its text, like the web composer, and sends the tagged actor ids alongside.
public enum CommentMentions {
	/// Who the `@` picker offers for `query`: matched case-insensitively on the name, people and
	/// agents alike, never the signed-in actor and never one already tagged.
	public static func candidates(
		query: String, actors: [ActorRef], selfID: String?, excluding tagged: Set<String>
	) -> [ActorRef] {
		actors
			.filter {
				$0.id != selfID && !tagged.contains($0.id)
					&& (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query))
			}
			.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
	}

	/// The text with the in-progress `@query` turned into `@Name `.
	public static func inserting(_ actor: ActorRef, into text: String) -> String {
		guard let match = MentionTrigger.find(in: text) else { return text }
		var result = text
		result.replaceSubrange(match.range, with: "@\(actor.name) ")
		return result
	}

	/// The comment as markdown with each known `@Name` as a link, so the renderer styles it as a
	/// mention. Longest names win ("@Senior Developer" beats "@Senior"), a name must end at a word
	/// boundary, and nothing inside a code span or fence is touched. The `mention:` scheme is not
	/// openable, so a tap does nothing.
	public static func linked(_ text: String, actors: [ActorRef]) -> String {
		guard text.contains("@"), !actors.isEmpty else { return text }
		let names = actors.map(\.name).filter { !$0.isEmpty }.sorted { $0.count > $1.count }
		let byName = Dictionary(actors.map { ($0.name, $0.id) }, uniquingKeysWith: { a, _ in a })
		var out = ""
		var inCode = false
		var index = text.startIndex
		while index < text.endIndex {
			let ch = text[index]
			if ch == "`" { inCode.toggle() }
			let atBoundary = index == text.startIndex || !(text[text.index(before: index)].isLetter || text[text.index(before: index)].isNumber)
			if ch == "@", !inCode, atBoundary {
				let rest = text[text.index(after: index)...]
				if let name = names.first(where: { name in
					guard rest.hasPrefix(name) else { return false }
					let after = rest.dropFirst(name.count).first
					return after.map { !($0.isLetter || $0.isNumber || $0 == "_") } ?? true
				}), let id = byName[name] {
					let safe = name.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
					out += "[@\(safe)](mention:\(id))"
					index = text.index(index, offsetBy: 1 + name.count)
					continue
				}
			}
			out.append(ch)
			index = text.index(after: index)
		}
		return out
	}

	/// Only the tagged ids whose `@Name` is still in the text: deleting the name untags the person.
	public static func active(_ tagged: [ActorRef], in text: String) -> [String] {
		var seen = Set<String>()
		return tagged.compactMap { actor in
			text.contains("@\(actor.name)") && seen.insert(actor.id).inserted ? actor.id : nil
		}
	}
}
