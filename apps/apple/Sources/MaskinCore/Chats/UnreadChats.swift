import Foundation

extension Collection where Element == ConversationSummary {
	/// How many chats have something unread (not how many messages): the Chats tab badge.
	public var unreadChatCount: Int { filter(\.isUnread).count }
}
