import Foundation

/// How a reply is posted into a thread: under which root, and whether it also goes to the main
/// timeline ("Also send to chat"). Persisted with the queued send, so plain data.
public struct ChatSendThread: Codable, Sendable, Equatable {
	public var rootID: Int
	public var alsoInChannel: Bool

	public init(rootID: Int, alsoInChannel: Bool = false) {
		self.rootID = rootID
		self.alsoInChannel = alsoInChannel
	}
}

/// What the server says about a thread, carried on its root message: how many replies, how many
/// the caller has not read, who took part.
public struct ThreadSummary: Codable, Sendable, Equatable, Hashable {
	public var replyCount: Int
	public var unreadCount: Int
	public var lastReplyID: Int
	public var lastReplyAt: Date?
	/// The root's author first, then repliers in order of first reply; at most three.
	public var participants: [ChatParticipant]

	public init(
		replyCount: Int, unreadCount: Int = 0, lastReplyID: Int, lastReplyAt: Date? = nil,
		participants: [ChatParticipant] = []
	) {
		self.replyCount = replyCount
		self.unreadCount = unreadCount
		self.lastReplyID = lastReplyID
		self.lastReplyAt = lastReplyAt
		self.participants = participants
	}

	/// Avatars the pill stacks.
	public static let participantLimit = 3

	/// The summary as it stands now: the server's, plus replies that arrived after it was taken.
	/// The incremental sync re-reads only newer messages, so a root fetched earlier never gets a
	/// fresh summary; the replies that did arrive are folded in here instead.
	///
	/// `readThrough` is the highest reply id the caller has opened the thread past (nil: never).
	/// Replies from `currentActorID` never count as unread.
	public static func current(
		base: ThreadSummary?, rootAuthor: ChatParticipant, replies: [ChatMessage],
		currentActorID: String, readThrough: Int?
	) -> ThreadSummary? {
		let known = base?.lastReplyID ?? 0
		let newer = replies.filter { ($0.serverID ?? 0) > known }
		guard base != nil || !newer.isEmpty else { return nil }
		var participants = base?.participants ?? [rootAuthor]
		for reply in newer where participants.count < participantLimit {
			if !participants.contains(where: { $0.id == reply.actorID }) {
				participants.append(ChatParticipant(id: reply.actorID, name: reply.actorName, kind: reply.author))
			}
		}
		let newest = newer.compactMap(\.serverID).max() ?? known
		let cursor = readThrough ?? 0
		let baseUnread = base.map { $0.lastReplyID <= cursor ? 0 : $0.unreadCount } ?? 0
		let newUnread = newer.filter {
			$0.actorID != currentActorID && ($0.serverID ?? 0) > cursor
		}.count
		return ThreadSummary(
			replyCount: (base?.replyCount ?? 0) + newer.count, unreadCount: baseUnread + newUnread,
			lastReplyID: newest, lastReplyAt: newer.last?.createdAt ?? base?.lastReplyAt,
			participants: participants)
	}

	/// "3 replies" / "1 new reply": what the pill and list rows read.
	public var label: String { Self.label(count: replyCount, unread: unreadCount) }

	public static func label(count: Int, unread: Int) -> String {
		if unread > 0 { return unread == 1 ? "1 new reply" : "\(unread) new replies" }
		return count == 1 ? "1 reply" : "\(count) replies"
	}
}

/// One row of the Threads screen: where the thread lives, its first message and its newest reply.
public struct ThreadListItem: Identifiable, Equatable, Sendable {
	public var conversationID: String
	public var conversationTitle: String
	public var root: ChatMessage
	public var summary: ThreadSummary
	public var lastReply: ChatMessage?

	public var id: String { "\(conversationID):\(root.serverID ?? 0)" }
	public var isUnread: Bool { summary.unreadCount > 0 }
	public var activityDate: Date? { lastReply?.createdAt ?? summary.lastReplyAt ?? root.createdAt }

	public init(
		conversationID: String, conversationTitle: String, root: ChatMessage, summary: ThreadSummary,
		lastReply: ChatMessage?
	) {
		self.conversationID = conversationID
		self.conversationTitle = conversationTitle
		self.root = root
		self.summary = summary
		self.lastReply = lastReply
	}

	/// "Magnus: Keep Qualifier until…": the newest reply with its author, or the root's text.
	public var snippet: String {
		if let lastReply {
			return "\(lastReply.actorName): \(ChatPreviewText.plain(lastReply.content))"
		}
		return ChatPreviewText.plain(root.content)
	}
}

/// The Threads screen's two sections: threads with replies you have not read, then the rest.
public struct ThreadListSections: Equatable, Sendable {
	public var new: [ThreadListItem]
	public var earlier: [ThreadListItem]

	public init(_ items: [ThreadListItem]) {
		let sorted = items.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
		new = sorted.filter(\.isUnread)
		earlier = sorted.filter { !$0.isUnread }
	}

	public var isEmpty: Bool { new.isEmpty && earlier.isEmpty }
	public var unreadCount: Int { new.count }
}

/// Who a thread reply is addressed to. The reply is a plain message in the conversation, so the
/// addressee is a mention: that is what wakes an agent. Candidates are the root's author (when not
/// you) and then the conversation's agents.
public enum ThreadReplyTargets {
	public static func candidates(
		rootAuthor: ChatParticipant, participants: [ChatParticipant], currentActorID: String
	) -> [ChatParticipant] {
		var out: [ChatParticipant] = []
		func add(_ p: ChatParticipant) {
			if p.id != currentActorID, !out.contains(where: { $0.id == p.id }) { out.append(p) }
		}
		add(rootAuthor)
		for p in participants where p.kind == .agent { add(p) }
		return out
	}
}

extension JSONValue {
	var arrayValue: [JSONValue]? {
		if case .array(let items) = self { return items }
		return nil
	}
}

/// One emoji on a message: how many people used it, whether you did, and who.
public struct MessageReaction: Codable, Sendable, Equatable, Hashable {
	public var emoji: String
	public var count: Int
	public var reactedByMe: Bool
	public var people: [ChatParticipant]

	public init(emoji: String, count: Int, reactedByMe: Bool, people: [ChatParticipant] = []) {
		self.emoji = emoji
		self.count = count
		self.reactedByMe = reactedByMe
		self.people = people
	}

	/// The five the menu offers, in order.
	public static let quick = ["👍", "❤️", "😂", "✅", "👀"]

	/// The list after you add or take back `emoji`. Counts never go below zero, an emoji nobody
	/// uses any more disappears, and a new one goes last (the server orders by first use).
	public static func toggling(
		_ emoji: String, in reactions: [MessageReaction], me: ChatParticipant
	) -> [MessageReaction] {
		var out = reactions
		if let index = out.firstIndex(where: { $0.emoji == emoji }) {
			if out[index].reactedByMe {
				out[index].count = max(out[index].count - 1, 0)
				out[index].reactedByMe = false
				out[index].people.removeAll { $0.id == me.id }
				if out[index].count == 0 { out.remove(at: index) }
			} else {
				out[index].count += 1
				out[index].reactedByMe = true
				out[index].people.append(me)
			}
		} else {
			out.append(MessageReaction(emoji: emoji, count: 1, reactedByMe: true, people: [me]))
		}
		return out
	}
}
