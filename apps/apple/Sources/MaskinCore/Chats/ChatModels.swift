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
	public var participants: [ChatParticipant]
	/// The caller's read cursor (detail responses only).
	public var lastReadMessageID: Int?

	public init(
		id: String, title: String, lastMessageAt: Date? = nil, createdAt: Date? = nil,
		pinned: Bool = false, archived: Bool = false, unreadCount: Int = 0, snippet: String? = nil,
		snippetActorName: String? = nil, participants: [ChatParticipant] = [],
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

	public init(
		id: String, serverID: Int? = nil, conversationID: String, actorID: String, actorName: String,
		author: ChatParticipant.Kind, kind: String = "message", content: String, createdAt: Date? = nil,
		editedAt: Date? = nil, metadata: JSONValue? = nil, status: Status = .sent,
		idempotencyKey: String? = nil
	) {
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
		editedAt: Date? = nil, metadata: JSONValue? = nil
	) -> ChatMessage {
		ChatMessage(
			id: "m\(serverID)", serverID: serverID, conversationID: conversationID, actorID: actorID,
			actorName: actorName, author: author, kind: kind, content: content, createdAt: createdAt,
			editedAt: editedAt, metadata: metadata)
	}

	public var isSystem: Bool { kind == "system" }
	public var isPending: Bool { serverID == nil }

	/// An agent's end-of-turn reply that the backend marked as an error (model API failure,
	/// credentials, …). The UI offers "Try again" on these.
	public var isErrorReply: Bool {
		metadata?["final_output"]?["is_error"]?.boolValue == true
	}

	public var isFailed: Bool {
		if case .failed = status { return true }
		return false
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
