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

	/// Spoken at about 200 words a minute.
	public static func readSeconds(_ text: String) -> Int {
		let words = text.split(whereSeparator: \.isWhitespace).count
		return Int((Double(words) / 200 * 60).rounded(.up))
	}

	/// Whole minutes, never under one: "3" for a three-minute briefing.
	public static func readMinutes(_ text: String) -> Int { max(1, Int((Double(readSeconds(text)) / 60).rounded(.up))) }

	/// The line under the greeting: "3 MIN \u{00B7} AIRPODS", or "3 MIN \u{00B7} WATCH SPEAKER".
	public static func meta(minutes: Int, headphones: Bool) -> String {
		"\(minutes) MIN \u{00B7} \(headphones ? "AIRPODS" : "WATCH SPEAKER")"
	}

	/// A playback time as "1:12".
	public static func clock(_ seconds: Int) -> String {
		let s = max(0, seconds)
		return "\(s / 60):" + String(format: "%02d", s % 60)
	}
}
