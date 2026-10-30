import Foundation

/// What the card for a linked agent shows. Never the agent's instructions, tools or keys.
public struct LinkedAgent: Equatable, Sendable {
	public var target: LinkedTarget
	public var name: String
	/// The first lines of the description as plain words. Nil when the agent has none.
	public var summary: String?
	/// True while a session is running. Nil when the sessions could not be read: the badge and the
	/// last-active fact are then left out, never guessed.
	public var isWorking: Bool?
	public var lastActive: Date?
	public var skillCount: Int

	public init(
		target: LinkedTarget, name: String, summary: String? = nil, isWorking: Bool? = nil, lastActive: Date? = nil,
		skillCount: Int = 0
	) {
		self.target = target
		self.name = name
		self.summary = summary
		self.isWorking = isWorking
		self.lastActive = lastActive
		self.skillCount = skillCount
	}

	/// The agent's name, or "Agent" when it has none.
	public var displayName: String {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed.isEmpty ? "Agent" : trimmed
	}
}

/// What the card for a linked chat shows. Never an unread count.
public struct LinkedChat: Equatable, Sendable {
	public var target: LinkedTarget
	public var title: String
	public var isPinned: Bool
	public var isArchived: Bool
	/// Who wrote the newest message and its words as one plain line. Nil for a chat with no messages.
	public var lastAuthorID: String?
	public var lastAuthorName: String?
	public var lastAuthorIsAgent = false
	public var lastText: String?
	/// Everyone in the chat, by name.
	public var people: [String]
	public var updatedAt: Date?

	public init(
		target: LinkedTarget, title: String, isPinned: Bool = false, isArchived: Bool = false,
		lastAuthorID: String? = nil, lastAuthorName: String? = nil, lastAuthorIsAgent: Bool = false,
		lastText: String? = nil, people: [String] = [], updatedAt: Date? = nil
	) {
		self.target = target
		self.title = title
		self.isPinned = isPinned
		self.isArchived = isArchived
		self.lastAuthorID = lastAuthorID
		self.lastAuthorName = lastAuthorName
		self.lastAuthorIsAgent = lastAuthorIsAgent
		self.lastText = lastText
		self.people = people
		self.updatedAt = updatedAt
	}

	public var displayTitle: String {
		let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed.isEmpty ? "Untitled chat" : trimmed
	}

	/// "Author: words" for the newest message, or nil when there is none.
	public var summary: String? {
		guard let lastText else { return nil }
		guard let author = lastAuthorName, !author.isEmpty else { return lastText }
		return "\(author): \(lastText)"
	}

	/// "Pinned" or "Archived" (pinned wins), or nil.
	public var badge: String? { isPinned ? "Pinned" : (isArchived ? "Archived" : nil) }

	/// The names the People fact shows: the first three, then how many more.
	public var peopleLine: String? {
		guard !people.isEmpty else { return nil }
		let shown = people.prefix(3).joined(separator: ", ")
		return people.count > 3 ? "\(shown) +\(people.count - 3)" : shown
	}

	/// The newest message's words as one plain line, from markdown.
	public static func line(from content: String?) -> String? {
		LinkedObject.summary(from: content)
	}
}

/// The two reads an agent card and a chat card make, kept apart so the store tests against a fake.
public protocol LinkedPlacesRemote: Sendable {
	/// The agent behind an id. Nil when the address is a person, not an agent.
	func agent(id: String) async throws -> LinkedAgent?
	/// The chat behind an id. Nil when it cannot be shown to you: you are not in it, or it is gone.
	/// The two are one answer on purpose, so the card says nothing about whether a chat exists.
	func chat(id: String) async throws -> LinkedChat?
}
