import Foundation

/// A person or agent in a conversation, or a candidate for the new-chat picker.
public struct ChatParticipant: Identifiable, Hashable, Sendable, Codable {
	public enum Kind: String, Sendable, Codable { case human, agent }

	public var id: String
	public var name: String
	public var kind: Kind

	public init(id: String, name: String, kind: Kind) {
		self.id = id
		self.name = name
		self.kind = kind
	}

	/// The backend's `actorType` is an open string; anything that isn't "agent" is a person.
	public init(id: String, name: String, actorType: String) {
		self.init(id: id, name: name, kind: actorType == "agent" ? .agent : .human)
	}
}

/// A workspace actor offered in the new-chat picker, with the run state agents report.
public struct ChatActor: Identifiable, Hashable, Sendable {
	public enum AgentState: String, Sendable { case idle, running, paused, failed, unknown }

	public var participant: ChatParticipant
	public var agentState: AgentState
	public var summary: String?
	public var isSystem: Bool

	public var id: String { participant.id }

	public init(
		participant: ChatParticipant, agentState: AgentState = .idle, summary: String? = nil,
		isSystem: Bool = false
	) {
		self.participant = participant
		self.agentState = agentState
		self.summary = summary
		self.isSystem = isSystem
	}
}

/// One row of the Chats list, and the header of an open thread.
public struct ConversationSummary: Identifiable, Hashable, Sendable, Codable {
	public var id: String
	public var title: String
	public var lastMessageAt: Date?
	public var createdAt: Date?
	public var pinned: Bool
	public var archived: Bool
	public var unreadCount: Int
	/// Preview of the latest message (list responses only).
	public var snippet: String?
	public var snippetActorName: String?
	/// Who wrote the latest message (list responses only): a tick before the preview when it is you.
	public var snippetActorID: String?
	public var participants: [ChatParticipant]
	/// The caller's read cursor (detail responses only).
	public var lastReadMessageID: Int?

	public init(
		id: String, title: String, lastMessageAt: Date? = nil, createdAt: Date? = nil,
		pinned: Bool = false, archived: Bool = false, unreadCount: Int = 0, snippet: String? = nil,
		snippetActorName: String? = nil, snippetActorID: String? = nil, participants: [ChatParticipant] = [],
		lastReadMessageID: Int? = nil
	) {
		self.id = id
		self.title = title
		self.lastMessageAt = lastMessageAt
		self.createdAt = createdAt
		self.pinned = pinned
		self.archived = archived
		self.unreadCount = unreadCount
		self.snippet = snippet
		self.snippetActorName = snippetActorName
		self.snippetActorID = snippetActorID
		self.participants = participants
		self.lastReadMessageID = lastReadMessageID
	}

	/// The date the list sorts and groups by.
	public var activityDate: Date? { lastMessageAt ?? createdAt }
	public var isUnread: Bool { unreadCount > 0 }
}

public struct ConversationPage: Sendable, Equatable {
	public var conversations: [ConversationSummary]
	public var hasMore: Bool
	public init(conversations: [ConversationSummary], hasMore: Bool) {
		self.conversations = conversations
		self.hasMore = hasMore
	}
}

/// One message in a thread. `id` is stable for the life of the row (an optimistic message keeps
/// its id when the server confirms it), so SwiftUI never re-creates the row on send.
public struct ChatMessage: Identifiable, Equatable, Sendable {
	public enum Status: Equatable, Sendable {
		case sent
		case sending
		/// Held back (offline, signed out, backing off); the reason is for the user.
		case waiting(String)
		case failed(String)
	}

	public var id: String
	/// The server's message id; nil until the server has accepted it.
	public var serverID: Int?
	public var conversationID: String
	public var actorID: String
	public var actorName: String
	public var author: ChatParticipant.Kind
	/// `message`, or `system` for a centred divider line.
	public var kind: String
	public var content: String
	public var createdAt: Date?
	public var editedAt: Date?
	public var metadata: JSONValue?
	public var status: Status
	/// For a message this client is sending: the key that makes a retry idempotent.
	public var idempotencyKey: String?
	/// Sub-agent sessions this message handed work to; the thread shows a row for each.
	public var spawnedSessions: [SpawnedSession]
	/// The root message's server id when this is a reply inside a thread.
	public var threadRootID: Int?
	/// A thread reply the author also posted to the main timeline.
	public var alsoInChannel: Bool
	/// On a thread root that has replies: the server's summary of them.
	public var thread: ThreadSummary?
	/// Emoji on this message, in the order each was first used.
	public var reactions: [MessageReaction]

	public init(
		id: String, serverID: Int? = nil, conversationID: String, actorID: String, actorName: String,
		author: ChatParticipant.Kind, kind: String = "message", content: String, createdAt: Date? = nil,
		editedAt: Date? = nil, metadata: JSONValue? = nil, status: Status = .sent,
		idempotencyKey: String? = nil, spawnedSessions: [SpawnedSession] = [],
		threadRootID: Int? = nil, alsoInChannel: Bool = false, thread: ThreadSummary? = nil,
		reactions: [MessageReaction] = []
	) {
		self.reactions = reactions
		self.spawnedSessions = spawnedSessions
		self.threadRootID = threadRootID
		self.alsoInChannel = alsoInChannel
		self.thread = thread
		self.id = id
		self.serverID = serverID
		self.conversationID = conversationID
		self.actorID = actorID
		self.actorName = actorName
		self.author = author
		self.kind = kind
		self.content = content
		self.createdAt = createdAt
		self.editedAt = editedAt
		self.metadata = metadata
		self.status = status
		self.idempotencyKey = idempotencyKey
	}

	/// A message as the server returned it.
	public static func confirmed(
		serverID: Int, conversationID: String, actorID: String, actorName: String,
		author: ChatParticipant.Kind, kind: String = "message", content: String, createdAt: Date? = nil,
		editedAt: Date? = nil, metadata: JSONValue? = nil, spawnedSessions: [SpawnedSession] = [],
		threadRootID: Int? = nil, alsoInChannel: Bool = false, thread: ThreadSummary? = nil,
		reactions: [MessageReaction] = []
	) -> ChatMessage {
		ChatMessage(
			id: "m\(serverID)", serverID: serverID, conversationID: conversationID, actorID: actorID,
			actorName: actorName, author: author, kind: kind, content: content, createdAt: createdAt,
			editedAt: editedAt, metadata: metadata, spawnedSessions: spawnedSessions,
			threadRootID: threadRootID, alsoInChannel: alsoInChannel, thread: thread, reactions: reactions)
	}

	public var isSystem: Bool { kind == "system" }
	/// A reply inside a thread (it hangs under a root message).
	public var isThreadReply: Bool { threadRootID != nil }
	/// Replies stay out of the main timeline unless the author also sent them there.
	/// A hidden nudge that failed to send stays visible, so there is something to retry or discard: otherwise
	/// the card says "Allowed" and the agent was never told, with nothing on screen to show it.
	public var showsInTimeline: Bool { (threadRootID == nil || alsoInChannel) && (!isHiddenFromChat || isFailed) }
	public var isPending: Bool { serverID == nil }

	/// An agent's end-of-turn reply that the backend marked as an error (model API failure,
	/// credentials, …). The UI offers "Try again" on these.
	public var isErrorReply: Bool {
		metadata?["final_output"]?["is_error"]?.boolValue == true
	}

	/// The agent's end-of-turn reply (the web's `metadata.source == 'final_output'`).
	public var isFinalOutput: Bool {
		metadata?["source"]?.stringValue == "final_output" || metadata?["final_output"] != nil
	}

	/// A spoken line of a live voice call, which the server saves into the thread as the call runs
	/// (`metadata.source == 'voice'`).
	public var isVoiceTranscript: Bool { metadata?["source"]?.stringValue == "voice" }

	/// One to three emoji and nothing else: shown large, without a bubble, as chat apps do.
	public var isEmojiOnly: Bool {
		let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty, text.count <= 3 else { return false }
		return text.allSatisfy { character in
			// Past U+238C skips digits, #, * and © ® ™, which Unicode also marks as emoji.
			guard let first = character.unicodeScalars.first else { return false }
			return first.properties.isEmoji && first.value > 0x238C
		}
	}

	/// A person can fix their own sent words. Agent turns are session artifacts, and a message
	/// the server hasn't accepted yet has no id to edit.
	public func canEdit(by actorID: String?) -> Bool {
		serverID != nil && kind == "message" && author == .human && actorID != nil && self.actorID == actorID
			&& !isFailed
	}

	public var isFailed: Bool {
		if case .failed = status { return true }
		return false
	}

	/// A reply quotes the message it answers as a leading markdown blockquote (`ChatQuote.make`):
	/// `> **Name**` then the quoted lines. Split it off so the bubble can draw it as a quote rule
	/// and render only the reply itself as the message body.
	public var quotedReply: QuotedReply? { QuotedReply.parse(content) }
}

/// The quote at the top of a reply bubble: who is quoted, what they said, and the reply text.
public struct QuotedReply: Equatable, Sendable {
	public var author: String
	public var text: String
	/// The message with the quote removed.
	public var body: String

	public init(author: String, text: String, body: String) {
		self.author = author
		self.text = text
		self.body = body
	}

	/// Recognises exactly the shape `ChatQuote.make` writes: a blockquote whose first line is a
	/// bold name, followed by the reply. Any other blockquote is ordinary markdown.
	public static func parse(_ content: String) -> QuotedReply? {
		let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
		guard let first = lines.first, first.hasPrefix("> **"), first.hasSuffix("**"), first.count > 6 else {
			return nil
		}
		let author = String(first.dropFirst(4).dropLast(2))
		var quoted: [String] = []
		var index = 1
		while index < lines.count, lines[index].hasPrefix(">") {
			let line = lines[index].dropFirst().trimmingCharacters(in: .whitespaces)
			if !line.isEmpty { quoted.append(line) }
			index += 1
		}
		guard !author.isEmpty, !quoted.isEmpty else { return nil }
		let body = lines[index...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
		return QuotedReply(author: author, text: quoted.joined(separator: " "), body: body)
	}
}


public struct MessagePage: Sendable, Equatable {
	/// Oldest first.
	public var messages: [ChatMessage]
	public var hasMore: Bool
	public init(messages: [ChatMessage], hasMore: Bool) {
		self.messages = messages
		self.hasMore = hasMore
	}
}

public struct ChatsError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}

enum ChatDates {
	static func parse(_ string: String?) -> Date? {
		guard let string else { return nil }
		let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
		return (try? withFraction.parse(string)) ?? (try? Date.ISO8601FormatStyle().parse(string))
	}
}

extension JSONValue {
	var boolValue: Bool? {
		if case .bool(let b) = self { return b }
		return nil
	}
}

/// An agent run that belongs to a conversation (a row of `GET /api/sessions?conversation_id=`).
public struct ChatAgentSession: Identifiable, Equatable, Sendable {
	public enum Status: Equatable, Sendable {
		case pending, starting, running, paused, completed, failed, timeout, other(String)

		public init(_ raw: String) {
			switch raw {
			case "pending", "queued": self = .pending
			case "starting": self = .starting
			case "running", "snapshotting": self = .running
			case "paused": self = .paused
			case "completed": self = .completed
			case "failed": self = .failed
			case "timeout": self = .timeout
			default: self = .other(raw)
			}
		}

		/// The agent is (about to be) working on the reply.
		public var isLive: Bool { self == .pending || self == .starting || self == .running }
		public var isTroubled: Bool { self == .failed || self == .timeout }
	}

	public var id: String
	public var actorID: String
	public var status: Status
	public var currentActivity: String?
	public var startedAt: Date?
	public var updatedAt: Date?
	/// The conversation message that spawned this session, when the backend recorded it.
	public var messageID: Int?

	public init(
		id: String, actorID: String, status: Status, currentActivity: String? = nil,
		startedAt: Date? = nil, updatedAt: Date? = nil, messageID: Int? = nil
	) {
		self.id = id
		self.actorID = actorID
		self.status = status
		self.currentActivity = currentActivity
		self.startedAt = startedAt
		self.updatedAt = updatedAt
		self.messageID = messageID
	}
}

/// Caps the server enforces (`packages/shared/src/schemas/{conversations,sessions}.ts`).
public enum ChatLimits {
	/// `GET /conversations/{id}/messages?limit=` max.
	public static let maxMessagesPage = 200
	/// `GET /conversations?limit=` max.
	public static let maxConversationsPage = 100
	/// `GET /sessions?limit=` max.
	public static let maxSessionsPage = 100
	public static let maxMessageLength = 8000
	public static let maxAttachments = 10
	public static let maxFileBytes = 10 * 1024 * 1024
}
