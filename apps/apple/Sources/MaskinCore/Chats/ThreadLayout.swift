import Foundation

/// What the thread renders, top to bottom: day separators, system dividers and messages, with
/// consecutive messages from one author collapsed under a single header.
public enum ThreadItem: Identifiable, Equatable, Sendable {
	case daySeparator(Date)
	case system(ChatMessage)
	case message(ChatMessage, showsAuthor: Bool)

	public var id: String {
		switch self {
		case .daySeparator(let day): "day-\(Int(day.timeIntervalSince1970))"
		case .system(let m): m.id
		case .message(let m, _): m.id
		}
	}
}

public enum ThreadLayout {
	/// A run of one author's messages breaks after this long a pause.
	public static let runGap: TimeInterval = 5 * 60

	public static func items(
		for messages: [ChatMessage], calendar: Calendar = .current
	) -> [ThreadItem] {
		var items: [ThreadItem] = []
		var lastDay: Date?
		var previous: ChatMessage?
		for message in messages {
			let day = message.createdAt.map { calendar.startOfDay(for: $0) }
			if let day, day != lastDay {
				items.append(.daySeparator(day))
				lastDay = day
				previous = nil
			}
			if message.isSystem {
				items.append(.system(message))
				previous = nil
				continue
			}
			var showsAuthor = true
			if let previous, previous.actorID == message.actorID,
				let a = previous.createdAt, let b = message.createdAt, b.timeIntervalSince(a) < runGap
			{
				showsAuthor = false
			}
			items.append(.message(message, showsAuthor: showsAuthor))
			previous = message
		}
		return items
	}

	/// "Today", "Yesterday", or "Mon, Sep 29".
	public static func dayLabel(_ day: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
		if calendar.isDate(day, inSameDayAs: now) { return "Today" }
		if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: y) {
			return "Yesterday"
		}
		return day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
	}

	/// Title for a new conversation when the user doesn't type one: "Alex, Relay".
	public static func defaultTitle(for names: [String]) -> String {
		let list = names.prefix(3).joined(separator: ", ")
		return names.count > 3 ? "\(list) +\(names.count - 3)" : (list.isEmpty ? "New chat" : list)
	}
}
