import Foundation

/// What the thread renders, top to bottom: day separators, system dividers and messages, with
/// consecutive messages from one author collapsed under a single header.
public enum ThreadItem: Identifiable, Equatable, Sendable {
	case daySeparator(Date)
	case system(ChatMessage)
	case message(ChatMessage, showsAuthor: Bool)
	/// "N new", above the first message the reader hadn't seen when they opened the thread.
	case unreadDivider(count: Int)

	public var id: String {
		switch self {
		case .unreadDivider: "unread-divider"
		case .daySeparator(let day): "day-\(Int(day.timeIntervalSince1970))"
		case .system(let m): m.id
		case .message(let m, _): m.id
		}
	}
}

public enum ThreadLayout {
	/// A run of one author's messages breaks after this long a pause.
	public static let runGap: TimeInterval = 5 * 60

	/// - Parameters:
	///   - unreadAfter: the read cursor when the thread opened; with `currentActorID`, picks where
	///     the "new" divider goes (nil: no divider, e.g. a thread that was never read).
	public static func items(
		for messages: [ChatMessage], unreadAfter cursor: Int? = nil, currentActorID: String? = nil,
		calendar: Calendar = .current
	) -> [ThreadItem] {
		var items: [ThreadItem] = []
		var lastDay: Date?
		var previous: ChatMessage?
		// The first message from someone else past the cursor, and how many such there are.
		let unread = cursor.map { cursor in
			messages.filter {
				!$0.isSystem && ($0.serverID ?? 0) > cursor && ($0.serverID != nil) && $0.actorID != currentActorID
			}
		} ?? []
		let dividerBefore = unread.first?.id
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
			if message.id == dividerBefore {
				items.append(.unreadDivider(count: unread.count))
				previous = nil
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

	/// How one message sits in its run of consecutive messages from one author.
	public struct Run: Equatable, Sendable {
		/// The message just above, when this one continues its run (nil for the first of a run).
		public var previousID: String?
		/// Nothing from the same author follows directly, so this is where the run's tail, time
		/// and status belong.
		public var endsRun: Bool

		public init(previousID: String? = nil, endsRun: Bool = true) {
			self.previousID = previousID
			self.endsRun = endsRun
		}
	}

	/// Run position of every message in `items`, by message id.
	public static func runs(in items: [ThreadItem]) -> [String: Run] {
		var result: [String: Run] = [:]
		for (index, item) in items.enumerated() {
			guard case .message(let message, let showsAuthor) = item else { continue }
			var previousID: String?
			if !showsAuthor, index > 0, case .message(let previous, _) = items[index - 1] {
				previousID = previous.id
			}
			var endsRun = true
			if index + 1 < items.count, case .message(_, let nextShowsAuthor) = items[index + 1], !nextShowsAuthor {
				endsRun = false
			}
			result[message.id] = Run(previousID: previousID, endsRun: endsRun)
		}
		return result
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
