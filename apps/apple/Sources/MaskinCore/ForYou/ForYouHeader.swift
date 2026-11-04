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

	/// "Good afternoon, Sebastian": the For you title (v19). Morning to noon, afternoon to 18:00,
	/// evening after. Only the first word of the name is used; with no name the greeting stands alone.
	public static func greeting(name: String?, at date: Date, calendar: Calendar = .current) -> String {
		let hour = calendar.component(.hour, from: date)
		let part = hour < 12 ? "morning" : (hour < 18 ? "afternoon" : "evening")
		let first = name?.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
		return first.isEmpty ? "Good \(part)" : "Good \(part), \(first)"
	}

	/// The first sentence under the title: how many decisions wait on the reader.
	/// - Nothing is said until the feed has loaded, so a slow start never claims "Nothing is blocked".
	/// - With none open: "Nothing is blocked on you."
	public static func summary(blocking: [FeedEntry], loaded: Bool) -> String? {
		guard loaded else { return nil }
		switch blocking.count {
		case 0: return "Nothing is blocked on you."
		case 1: return "1 decision is waiting on you."
		case let n: return "\(n) decisions are waiting on you."
		}
	}
}
