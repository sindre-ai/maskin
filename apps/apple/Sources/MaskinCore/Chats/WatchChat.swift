import Foundation

/// What the watch's chat screens decide, kept out of the views so it is testable.
public enum WatchChat {
	/// One-tap replies. Short enough for a wrist button; the wearer dictates anything else.
	public static let quickReplies = ["Yes", "No", "Thanks", "On it"]

	/// The newest `limit` real messages, oldest first. System dividers ("X joined") are noise on a
	/// 40 mm screen, so they are dropped before the cut.
	public static func recent(_ messages: [ChatMessage], limit: Int = 6) -> [ChatMessage] {
		Array(messages.filter { $0.kind == "message" }.suffix(max(0, limit)))
	}

	/// Conversations worth a glance: unread first (most recent activity within), then the rest by
	/// recency, archived ones never. Capped, because a watch list is a glance, not an archive.
	public static func glance(_ conversations: [ConversationSummary], limit: Int = 12)
		-> [ConversationSummary]
	{
		let live = conversations.filter { !$0.archived }
		let byRecency: (ConversationSummary, ConversationSummary) -> Bool = {
			($0.lastMessageAt ?? .distantPast) > ($1.lastMessageAt ?? .distantPast)
		}
		let unread = live.filter { $0.unreadCount > 0 }.sorted(by: byRecency)
		let read = live.filter { $0.unreadCount == 0 }.sorted(by: byRecency)
		return Array((unread + read).prefix(max(0, limit)))
	}
}
