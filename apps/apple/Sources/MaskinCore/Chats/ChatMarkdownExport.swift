import Foundation

/// A chat as a Markdown file, for Export chat in the header menu: what the thread holds now, oldest
/// first. Hidden nudges, divider lines, unsent and failed messages stay out. Cards are not drawn;
/// only the words each person or agent wrote.
public enum ChatMarkdownExport {
	/// "38 messages from 3 people and 1 agent", counted over the exported messages.
	public static func summary(of messages: [ChatMessage]) -> String {
		let exported = included(messages)
		var seen = Set<String>()
		var people = 0
		var agents = 0
		for message in exported where seen.insert(message.actorID).inserted {
			if message.author == .agent { agents += 1 } else { people += 1 }
		}
		var parts: [String] = []
		if people > 0 { parts.append("\(people) \(people == 1 ? "person" : "people")") }
		if agents > 0 { parts.append("\(agents) \(agents == 1 ? "agent" : "agents")") }
		let count = "\(exported.count) \(exported.count == 1 ? "message" : "messages")"
		return parts.isEmpty ? count : "\(count) from \(parts.joined(separator: " and "))"
	}

	public static func markdown(title: String, messages: [ChatMessage], timeZone: TimeZone = .current) -> String {
		let exported = included(messages)
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = timeZone
		formatter.dateFormat = "yyyy-MM-dd HH:mm"
		var lines = ["# \(title)", "", summary(of: messages), ""]
		for message in exported {
			let when = message.createdAt.map { " · " + formatter.string(from: $0) } ?? ""
			lines.append("**\(message.actorName)**\(when)")
			lines.append("")
			lines.append(message.content.trimmingCharacters(in: .whitespacesAndNewlines))
			lines.append("")
		}
		return lines.joined(separator: "\n")
	}

	/// A file name for the share sheet: the title with anything a file name dislikes taken out.
	public static func fileName(title: String) -> String {
		let cleaned = title.components(separatedBy: CharacterSet(charactersIn: "/\\:?*\"<>|\n")).joined(separator: " ")
			.trimmingCharacters(in: .whitespacesAndNewlines)
		return (cleaned.isEmpty ? "Chat" : cleaned) + ".md"
	}

	private static func included(_ messages: [ChatMessage]) -> [ChatMessage] {
		messages
			.filter { !$0.isSystem && !$0.isHiddenFromChat && !$0.isPending && !$0.isFailed && !$0.content.isEmpty }
			.sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
	}
}
