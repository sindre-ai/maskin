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

	/// Only the tagged ids whose `@Name` is still in the text: deleting the name untags the person.
	public static func active(_ tagged: [ActorRef], in text: String) -> [String] {
		var seen = Set<String>()
		return tagged.compactMap { actor in
			text.contains("@\(actor.name)") && seen.insert(actor.id).inserted ? actor.id : nil
		}
	}
}
