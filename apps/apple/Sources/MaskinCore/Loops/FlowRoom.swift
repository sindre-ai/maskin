import Foundation

/// A flow's room: one thread where people and agents talk, with the flow's own events as quiet lines.
/// It is a read-time merge of the flow's chat messages, the comments the flow already had, and its
/// events. The flow's chat copies the flow's comments in when it is made and mirrors each message
/// back as a comment, so a message and a comment that are copies of each other show once.
public enum FlowRoom {
	/// The composer's placeholder (same words as the web).
	public static let placeholder = "Message the room"
	/// Shown only when there are no messages, no old comments and no events.
	public static let emptyTitle = "No messages yet"
	public static let emptyBody = "Messages and events from this flow show up here."

	/// Marks a chat message among the timeline's own items, so a retry or discard can find its way back.
	private static let itemPrefix = "room-"

	/// The flow's chat, found without caring whether it is archived: the live one first, then an
	/// archived one. Nil when the flow has no chat yet.
	public static func find(flowID: String, api: any ConversationsAPI) async throws -> ConversationSummary? {
		if let live = try await api.flowConversation(flowID: flowID, archived: false) { return live }
		return try await api.flowConversation(flowID: flowID, archived: true)
	}

	/// A chat message as a timeline comment, so the room draws it with the rows it already has.
	/// It has no event id, so it can't be replied to as a comment.
	public static func item(for message: ChatMessage) -> TimelineItem {
		let delivery: TimelineItem.Delivery
		switch message.status {
		case .sent: delivery = .sent
		case .sending, .waiting: delivery = .sending
		case .failed: delivery = .failed
		}
		return TimelineItem(
			id: itemPrefix + message.id, kind: message.isSystem ? .activity(message.content) : .comment(message.content),
			actorId: message.actorID, date: message.createdAt, delivery: delivery)
	}

	/// The chat message id behind a room item, or nil for a comment or an event.
	public static func messageID(fromItemID id: String) -> String? {
		id.hasPrefix(itemPrefix) ? String(id.dropFirst(itemPrefix.count)) : nil
	}

	/// The flow's events and comments with its chat messages, oldest first. Thread replies stay out
	/// unless their author also sent them to the room. A message copied from a comment, and a comment
	/// mirrored from a message, show once (the comment is kept when it is the original, the message
	/// when it is). Items without a date go last; equal times keep the order they came in.
	public static func merged(timeline: [TimelineItem], messages: [ChatMessage]) -> [TimelineItem] {
		let commentIDs = Set(timeline.compactMap(\.eventId))
		let messageIDs = Set(messages.compactMap(\.serverID))
		let comments = timeline.filter { item in
			guard let mirrored = item.viaChatMessageID else { return true }
			return !messageIDs.contains(mirrored)
		}
		let chat = messages.filter(\.showsInTimeline).filter { message in
			guard case .number(let n)? = message.metadata?["comment_event_id"] else { return true }
			return !commentIDs.contains(Int(n))
		}
		let all = comments + chat.map(item(for:))
		return all.enumerated().sorted { a, b in
			let left = a.element.date ?? .distantFuture
			let right = b.element.date ?? .distantFuture
			if left != right { return left < right }
			return a.offset < b.offset
		}.map(\.element)
	}
}
