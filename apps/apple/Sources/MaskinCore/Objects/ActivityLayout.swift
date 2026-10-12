import Foundation

/// How the activity page reads each entry and labels each day (handoff 8-Objects).
public enum ActivityLayout {
	/// Text longer than this makes an entry a comment (avatar and bubble); anything shorter is one
	/// quiet line.
	public static let commentThreshold = 110
	/// A comment's bubble shows this many lines before "Show more".
	public static let bubbleLines = 6

	/// A comment carries user- or agent-authored text over ~110 characters (or something attached to
	/// it, which a one-line event can't show); otherwise it is a one-line event.
	public static func isComment(_ item: TimelineItem) -> Bool {
		guard case .comment(let text) = item.kind else { return false }
		if item.delivery != .sent { return true }  // an unsent comment keeps its retry controls
		return text.trimmingCharacters(in: .whitespacesAndNewlines).count > commentThreshold
			|| !item.refs.isEmpty || !item.attachments.isEmpty
	}

	/// "Today", "Yesterday", a weekday name within 6 days ("Mon"), otherwise "6 Oct".
	public static func dayLabel(_ day: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
		let start = calendar.startOfDay(for: day)
		let today = calendar.startOfDay(for: now)
		let days = calendar.dateComponents([.day], from: start, to: today).day ?? 0
		switch days {
		case ...0: return "Today"
		case 1: return "Yesterday"
		case 2...6:
			return start.formatted(
				Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar).weekday(.abbreviated))
		default:
			return start.formatted(
				Date.FormatStyle(locale: calendar.locale ?? .current, calendar: calendar).day().month(.abbreviated))
		}
	}

	/// Times show only under "Today".
	public static func showsTime(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> Bool {
		guard let date else { return false }
		return calendar.isDate(date, inSameDayAs: now)
	}

	/// Minutes to read a text at ~200 words a minute, at least one.
	public static func readMinutes(_ text: String) -> Int {
		let words = text.split { $0.isWhitespace }.count
		return max(1, Int((Double(words) / 200).rounded(.up)))
	}

	/// "Read all \u{00B7} 2 min".
	public static func readLabel(_ text: String) -> String {
		"Read all \u{00B7} \(readMinutes(text)) min"
	}
}
