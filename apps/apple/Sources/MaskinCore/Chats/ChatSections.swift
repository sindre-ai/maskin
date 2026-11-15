import Foundation

/// One of the person's own sections in the Chats list. Personal and stored on the server, so the
/// same sections show on web and iPhone. A chat is in at most one section.
public struct ChatSection: Identifiable, Equatable, Hashable, Sendable, Codable {
	public var id: String
	public var name: String
	/// 0-based, in the order the person arranged their sections.
	public var position: Int
	public var collapsed: Bool
	/// The chats in the section the caller can still see, newest message first.
	public var conversationIDs: [String]

	public init(id: String, name: String, position: Int = 0, collapsed: Bool = false, conversationIDs: [String] = []) {
		self.id = id
		self.name = name
		self.position = position
		self.collapsed = collapsed
		self.conversationIDs = conversationIDs
	}
}

/// The three automatic views beside the person's own sections. They are filters, not groups: a chat
/// in a section can also be in Waiting on you.
public enum TeamView: String, CaseIterable, Sendable, Hashable {
	case waiting, running, quiet

	/// Tile and view title.
	public var label: String {
		switch self {
		case .waiting: "Waiting on you"
		case .running: "Running"
		case .quiet: "Quiet"
		}
	}

	/// Under the title of the open view.
	public var intro: String {
		switch self {
		case .waiting: "Mentions and open cards, newest first."
		case .running: "Chats where an agent is working right now."
		case .quiet: "No message for \(TeamViewRules.quietDays) days. A new message brings a chat back to your list. Pin it or put it in a section to keep it."
		}
	}

	public var emptyTitle: String {
		switch self {
		case .waiting: "Nothing is waiting on you"
		case .running: "No agent is running"
		case .quiet: "Nothing is quiet"
		}
	}

	public var emptyMessage: String {
		switch self {
		case .waiting: "Mentions and open cards from agents show up here."
		case .running: "Chats show up here while an agent works in them."
		case .quiet: "Chats with no message for \(TeamViewRules.quietDays) days show up here."
		}
	}
}

/// The rules the sectioned list shares with the web list, as plain functions so every branch is tested.
public enum TeamViewRules {
	/// A chat leaves the main list after this many days without a message. One rule for web and iPhone.
	public static let quietDays = 7

	/// The line under a row in a view, saying why the chat is there.
	public static func reason(for view: TeamView, _ c: ConversationSummary, now: Date = Date(), calendar: Calendar = .current)
		-> String?
	{
		switch view {
		case .running: return "Agent running now"
		case .quiet:
			let days = daysQuiet(c, now: now, calendar: calendar)
			return "Last message \(days) \(days == 1 ? "day" : "days") ago"
		case .waiting:
			let text = c.cardText?.trimmingCharacters(in: .whitespacesAndNewlines)
			let hasText = !(text ?? "").isEmpty
			if c.mentionsUnread > 0 { return hasText ? "Mentions you: \"\(text ?? "")\"" : "Mentions you" }
			if c.openCards > 0 { return hasText ? "Asks you: \"\(text ?? "")\"" : "Asks you" }
			return nil
		}
	}

	/// Whole days since the chat's last message, for "Last message N days ago".
	public static func daysQuiet(_ c: ConversationSummary, now: Date = Date(), calendar: Calendar = .current) -> Int {
		guard let last = c.activityDate else { return 0 }
		return max(0, calendar.dateComponents([.day], from: last, to: now).day ?? 0)
	}

	/// "Quiet since 9 Nov": the day of the last message, for the bar above a quiet chat.
	public static func quietSince(_ date: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
		let formatter = DateFormatter()
		formatter.calendar = calendar
		formatter.locale = locale
		formatter.setLocalizedDateFormatFromTemplate("d MMM")
		return formatter.string(from: date)
	}

	/// Whether the thread bar "Quiet since ..." shows: the chat has been silent for the quiet period
	/// and nothing keeps it in the list (a pin, a room, an archive, a section).
	public static func showsQuietBar(
		_ c: ConversationSummary, sections: [ChatSection], now: Date = Date(), calendar: Calendar = .current
	) -> Bool {
		if c.archived || c.pinned || c.isRoom || c.agentRunning { return false }
		if sections.contains(where: { $0.conversationIDs.contains(c.id) }) { return false }
		guard let last = c.lastMessageAt else { return false }
		let limit = calendar.date(byAdding: .day, value: -quietDays, to: now) ?? now
		return last <= limit
	}

	/// The count on a tile: rows for Running and Quiet, what waits for Waiting on you.
	public static func tileCount(_ view: TeamView, _ rows: [ConversationSummary]) -> Int {
		view == .waiting ? rows.reduce(0) { $0 + $1.waitingCount } : rows.count
	}

	/// "N quiet chats left your list" and the footer's "N quiet chats are in Quiet".
	public static func quietChats(_ count: Int) -> String { "\(count) quiet \(count == 1 ? "chat" : "chats")" }

	/// Whether `name` is already one of the person's sections (case-insensitive), for the duplicate error.
	public static func hasSection(named name: String, in sections: [ChatSection], excluding id: String? = nil) -> Bool {
		let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines)
		return sections.contains { $0.id != id && $0.name.localizedCaseInsensitiveCompare(wanted) == .orderedSame }
	}

	public static func duplicateMessage(_ name: String) -> String {
		"You already have a section called \(name.trimmingCharacters(in: .whitespacesAndNewlines))."
	}

	/// "Deleted {name}. {n} chat is back in your list."
	public static func deletedMessage(name: String, chats: Int) -> String {
		"Deleted \(name). \(chats) \(chats == 1 ? "chat is" : "chats are") back in your list."
	}
}

extension Collection where Element == ConversationSummary {
	/// The Chats tab badge once sections are on: what waits on you, summed over the chats.
	public var waitingBadgeTotal: Int { reduce(0) { $0 + $1.badgeCount } }
}
