import Foundation

/// The two lines around the "For you" title: the date above it and one sentence under it saying
/// what is blocked on the reader. Both come from real state; nothing here is written by hand.
public enum ForYouHeader {
	/// "SUN 18 OCT": weekday, day and month, short, in capitals. Fixed to English like the mockup,
	/// so the line reads the same as the design whatever the phone's language.
	public static func dateLine(_ date: Date, calendar: Calendar = .current) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.calendar = calendar
		formatter.timeZone = calendar.timeZone
		formatter.dateFormat = "EEE d MMM"
		return formatter.string(from: date).uppercased()
	}

	/// The same day as VoiceOver should say it: "Sunday 18 October". The capitals above would be
	/// spelled out letter by letter.
	public static func spokenDate(_ date: Date, calendar: Calendar = .current) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.calendar = calendar
		formatter.timeZone = calendar.timeZone
		formatter.dateFormat = "EEEE d MMMM"
		return formatter.string(from: date)
	}

	/// What is blocked on the reader, in one sentence.
	/// - Nothing is said until the feed has loaded, so a slow start never claims "Nothing is blocked".
	/// - With no open ask: "Nothing is blocked on you."
	/// - Otherwise the most urgent open ask (the feed's own order): "{agent} needs a call: {title}".
	///   An ask whose agent or title is unknown gives no sentence rather than an invented one.
	public static func summary(
		blocking: [FeedEntry], loaded: Bool, sender: (ForYouCard) -> String?
	) -> String? {
		guard loaded else { return nil }
		guard let first = blocking.first else { return "Nothing is blocked on you." }
		guard let agent = sender(first.card)?.trimmed.nonEmpty,
			let title = first.card.decision?.title.trimmed.nonEmpty
		else { return nil }
		let ask = title.hasSuffix("?") || title.hasSuffix(".") ? title : title + "."
		return "\(agent) needs a call: \(ask)"
	}
}
