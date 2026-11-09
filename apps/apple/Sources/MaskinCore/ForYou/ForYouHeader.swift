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

	/// The prose under the title (v3): how many decisions wait on the reader, then, when there is
	/// something real to say, how many calls they have answered and who is carrying on because of them.
	/// - Nothing is said until the feed has loaded, so a slow start never claims "Nothing is blocked".
	/// - With none open: "Nothing is blocked on you."
	/// - `answered` counts the reader's own decisions this sitting; `carryingOn` names the agents
	///   working on them. A part with nothing behind it (0, empty) is left out, never invented.
	public static func summary(
		blocking: [FeedEntry], answered: Int = 0, carryingOn: [String] = [], loaded: Bool
	) -> String? {
		guard loaded else { return nil }
		var sentences: [String]
		switch blocking.count {
		case 0: sentences = ["Nothing is blocked on you."]
		case 1: sentences = ["1 decision is waiting on you."]
		case let n: sentences = ["\(n) decisions are waiting on you."]
		}
		if let tail = progressClause(answered: answered, carryingOn: carryingOn) {
			sentences.append(tail)
		}
		return sentences.joined(separator: " ")
	}

	/// "You've answered 3 so far, and Developer is carrying on." Nil when there is nothing to say.
	static func progressClause(answered: Int, carryingOn: [String]) -> String? {
		let names = naturalList(carryingOn)
		switch (answered > 0, names) {
		case (true, let names?):
			return "You\u{2019}ve answered \(answered) so far, and \(names) \(carryingOn.count == 1 ? "is" : "are") carrying on."
		case (true, nil): return "You\u{2019}ve answered \(answered) so far."
		case (false, let names?): return "\(names) \(carryingOn.count == 1 ? "is" : "are") carrying on."
		case (false, nil): return nil
		}
	}

	/// "A", "A and B", "A, B and C"; nil for an empty list.
	static func naturalList(_ names: [String]) -> String? {
		switch names.count {
		case 0: return nil
		case 1: return names[0]
		default: return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
		}
	}
}
