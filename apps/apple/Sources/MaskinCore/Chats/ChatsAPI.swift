import Foundation

/// Conversation-list endpoints. A protocol so `ConversationsStore` tests without a server.
public protocol ConversationsAPI: Sendable {
	/// `pinnedOnly` / `unreadOnly` are sent only when true: the server reads any present value of
	/// a boolean query (even "false") as true.
	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int)
		async throws -> ConversationPage
	/// `POST /api/conversations`. Returns the created conversation.
	func create(
		title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String
	) async throws -> ConversationSummary
	/// Same, with the first message's metadata (its attachments and mentions).
	func create(
		title: String, participantIDs: [String], initialMessage: String?,
		initialMetadata: ChatSendMetadata?, idempotencyKey: String
	) async throws -> ConversationSummary
	/// `POST /api/conversations` with `direct: true`: the one stored direct message with this actor,
	/// created on first use. `title` only names it when it is created.
	func directChat(with participantID: String, title: String, idempotencyKey: String)
		async throws -> ConversationSummary
	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?,
		markUnread: Bool
	) async throws
	/// Workspace actors for the participant picker.
	func actors() async throws -> [ChatActor]
	/// The newest message in a conversation, which "read" is recorded against. The list rows
	/// carry no message id, so marking a chat read from the list has to ask.
	func latestMessageID(conversationID: String) async throws -> Int?
	/// Threads you started or replied in, across conversations, most recently active first.
	func threads(limit: Int) async throws -> [ThreadListItem]
}

extension ConversationsAPI {
	public func create(
		title: String, participantIDs: [String], initialMessage: String?,
		initialMetadata: ChatSendMetadata?, idempotencyKey: String
	) async throws -> ConversationSummary {
		try await create(
			title: title, participantIDs: participantIDs, initialMessage: initialMessage,
			idempotencyKey: idempotencyKey)
	}

	/// Sources without a stored direct message (test doubles) start a plain chat.
	public func directChat(with participantID: String, title: String, idempotencyKey: String)
		async throws -> ConversationSummary
	{
		try await create(
			title: title, participantIDs: [participantID], initialMessage: nil, idempotencyKey: idempotencyKey)
	}

	public func latestMessageID(conversationID: String) async throws -> Int? { nil }
	public func threads(limit: Int) async throws -> [ThreadListItem] { [] }

	public func list(archived: Bool, limit: Int, offset: Int) async throws -> ConversationPage {
		try await list(archived: archived, pinnedOnly: false, unreadOnly: false, limit: limit, offset: offset)
	}
}

/// Thread endpoints for one workspace.
extension ChatAPI {
	/// Sources that cannot edit (test doubles, read-only mirrors) fail with a plain message.
	public func edit(conversationID: String, messageID: Int, content: String) async throws -> ChatMessage {
		throw ChatsError("Editing isn't available here.")
	}
}

public protocol ChatAPI: Sendable {
	func detail(conversationID: String) async throws -> ConversationSummary
	/// Newest page first server-side; returned oldest-first here. `beforeID` pages into the past,
	/// `afterID` fetches only what is newer than a known message.
	func messages(
		conversationID: String, beforeID: Int?, afterID: Int?, limit: Int
	) async throws -> MessagePage
	func send(
		conversationID: String, content: String, metadata: ChatSendMetadata?, idempotencyKey: String
	) async throws -> ChatMessage
	/// The same, as a reply inside a thread. A source without threads refuses rather than
	/// quietly posting it to the main timeline.
	func send(
		conversationID: String, content: String, metadata: ChatSendMetadata?, thread: ChatSendThread?,
		idempotencyKey: String
	) async throws -> ChatMessage
	/// The replies of one thread, oldest first.
	func threadReplies(conversationID: String, rootID: Int) async throws -> [ChatMessage]
	/// Add (`add`) or take back your `emoji` on a message.
	func react(conversationID: String, messageID: Int, emoji: String, add: Bool) async throws
	/// Advance the caller's read marker for a thread to `lastMessageID`.
	func markThreadRead(conversationID: String, rootID: Int, lastMessageID: Int) async throws
	/// Ask the agents to answer again (`POST …/messages/{id}/retry`).
	func retry(conversationID: String, messageID: Int, agentID: String?) async throws
	func markRead(conversationID: String, lastMessageID: Int) async throws
	/// Replace the text of a message you wrote (`PATCH …/messages/{id}`); returns the stored row.
	func edit(conversationID: String, messageID: Int, content: String) async throws -> ChatMessage
	func addParticipants(conversationID: String, actorIDs: [String]) async throws
	func removeParticipant(conversationID: String, actorID: String) async throws
	func rename(conversationID: String, title: String) async throws
	func actors() async throws -> [ChatActor]
	/// Agent sessions that belong to this conversation, newest first.
	func sessions(conversationID: String) async throws -> [ChatAgentSession]
	func stopSession(sessionID: String) async throws
	func resumeSession(sessionID: String) async throws
}

extension ChatAPI {
	public func send(
		conversationID: String, content: String, metadata: ChatSendMetadata?, thread: ChatSendThread?,
		idempotencyKey: String
	) async throws -> ChatMessage {
		guard thread == nil else { throw ChatsError("Threads aren't available here.") }
		return try await send(
			conversationID: conversationID, content: content, metadata: metadata,
			idempotencyKey: idempotencyKey)
	}
	public func threadReplies(conversationID: String, rootID: Int) async throws -> [ChatMessage] { [] }
	public func react(conversationID: String, messageID: Int, emoji: String, add: Bool) async throws {
		throw ChatsError("Reactions aren't available here.")
	}
	public func markThreadRead(conversationID: String, rootID: Int, lastMessageID: Int) async throws {}
	public func removeParticipant(conversationID: String, actorID: String) async throws {
		throw ChatsError("Removing people isn't available.")
	}
	public func rename(conversationID: String, title: String) async throws {
		throw ChatsError("Renaming isn't available.")
	}
	public func sessions(conversationID: String) async throws -> [ChatAgentSession] { [] }
	public func stopSession(sessionID: String) async throws {
		throw ChatsError("Stopping isn't available.")
	}
	public func resumeSession(sessionID: String) async throws {
		throw ChatsError("Resuming isn't available.")
	}
}

/// A non-2xx answer from a write, kept as a status so the outbox can tell "will never work"
/// (4xx) from "try again" (5xx, offline).
public struct ChatsHTTPError: Error, Equatable, Sendable {
	/// What a send refused for holding a secret says (`RAW_SECRET_DETECTED` on the server).
	public static let rawSecretMessage =
		"That message looks like it contains a secret, so it wasn't sent. Cut the secret out, or save it to the Keychain."

	public var status: Int
	public var message: String
	public init(status: Int, message: String) {
		self.status = status
		self.message = message
	}
}

/// Uploads one file to the workspace (`POST /api/files`, base64 JSON, 10 MB cap).
public protocol ChatFileUploading: Sendable {
	func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef
}
