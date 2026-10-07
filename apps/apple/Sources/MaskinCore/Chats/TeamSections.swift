import Foundation

/// One row of the Team list's person view: a person or an agent with every conversation you have
/// with them, or a group chat standing for itself. Several conversations collapse into one row
/// that expands inline.
public struct TeamPerson: Identifiable, Equatable, Sendable {
	public enum Kind: Sendable { case human, agent, group }

	public var id: String
	public var name: String
	public var kind: Kind
	/// Who the avatar shows (the other party, or the group's members).
	public var participants: [ChatParticipant]
	/// Newest activity first.
	public var conversations: [ConversationSummary]

	/// The conversation with the newest activity: what the row previews.
	public var latest: ConversationSummary { conversations[0] }
	public var unreadCount: Int { conversations.reduce(0) { $0 + $1.unreadCount } }
	public var isUnread: Bool { conversations.contains(where: \.isUnread) }
	public var hasSeveral: Bool { conversations.count > 1 }

	/// The row as a conversation row draws it: the person's name as the title, the newest
	/// conversation's preview and time, every conversation's unread count added up.
	public var rowSummary: ConversationSummary {
		var row = latest
		row.title = name
		row.unreadCount = unreadCount
		return row
	}
}

/// What the Team list shows in its person view.
public struct TeamSections: Equatable, Sendable {
	/// Pinned conversations, as tiles. A pinned conversation is not repeated in `people`.
	public var pinned: [ConversationSummary]
	/// Everyone with something unread (pinned chats included), newest first.
	public var unread: [TeamPerson]
	/// Humans first, then agents; each newest first.
	public var people: [TeamPerson]

	/// "PEOPLE & AGENTS" shows this many rows until the reader asks for all.
	public static let peopleCap = 5

	public var isEmpty: Bool { pinned.isEmpty && people.isEmpty && unread.isEmpty }

	/// The conversations behind the unread card, for "Mark all read".
	public var unreadConversationIDs: [String] {
		unread.flatMap { $0.conversations.filter(\.isUnread).map(\.id) }
	}

	/// `people` capped, unless `showAll`.
	public func visiblePeople(showAll: Bool) -> [TeamPerson] {
		showAll ? people : Array(people.prefix(Self.peopleCap))
	}

	/// The label of the expander under the capped list, nil when everything already fits.
	public func morePeopleLabel(showAll: Bool) -> String? {
		guard people.count > Self.peopleCap else { return nil }
		return showAll ? "Show fewer" : "All \(people.count) people & agents"
	}
}

extension ConversationGrouping {
	/// One person row per other party of a one-to-one conversation; a group chat is its own row.
	/// Rows are ordered by their newest conversation.
	public static func people(_ conversations: [ConversationSummary], currentActorID: String?)
		-> [TeamPerson]
	{
		let sorted = conversations.sorted {
			($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast)
		}
		var order: [String] = []
		var rows: [String: TeamPerson] = [:]
		for c in sorted {
			let others = c.others(excluding: currentActorID)
			let person: TeamPerson
			if others.count == 1, let only = others.first {
				person = TeamPerson(
					id: only.id, name: only.name, kind: only.kind == .agent ? .agent : .human,
					participants: [only], conversations: [])
			} else {
				person = TeamPerson(
					id: "chat-\(c.id)", name: ChatPreviewText.plain(c.title), kind: .group,
					participants: others, conversations: [])
			}
			if rows[person.id] == nil {
				rows[person.id] = person
				order.append(person.id)
			}
			rows[person.id]?.conversations.append(c)
		}
		return order.compactMap { rows[$0] }
	}

	/// The person view: pinned tiles, who has something unread, then people before agents.
	public static func teamSections(_ conversations: [ConversationSummary], currentActorID: String?)
		-> TeamSections
	{
		let pinned = conversations.filter(\.pinned)
			.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
		let everyone = people(conversations.filter(\.isUnread), currentActorID: currentActorID)
		let rest = people(conversations.filter { !$0.pinned }, currentActorID: currentActorID)
		return TeamSections(
			pinned: pinned, unread: everyone,
			people: rest.filter { $0.kind != .agent } + rest.filter { $0.kind == .agent })
	}
}
