import Foundation

/// The brief arrives as markdown; a wrist wants plain sentences, and so does a speech synthesiser.
public enum WatchBriefingText {
	public static func plain(_ markdown: String) -> String {
		var lines: [String] = []
		for raw in markdown.components(separatedBy: "\n") {
			var line = raw.trimmingCharacters(in: .whitespaces)
			while line.hasPrefix("#") { line.removeFirst() }
			for bullet in ["- ", "* ", "• "] where line.hasPrefix(bullet) { line.removeFirst(bullet.count) }
			line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "")
				.replacingOccurrences(of: "`", with: "")
			line = line.replacingOccurrences(
				of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
			lines.append(line.trimmingCharacters(in: .whitespaces))
		}
		return lines.joined(separator: "\n")
			.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
			.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	public static func paragraphs(_ text: String) -> [String] {
		text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
			.filter { !$0.isEmpty }
	}
}
