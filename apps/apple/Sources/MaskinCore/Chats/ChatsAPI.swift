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
	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?,
		markUnread: Bool
	) async throws
	/// Workspace actors for the participant picker.
	func actors() async throws -> [ChatActor]
}

extension ConversationsAPI {
	public func list(archived: Bool, limit: Int, offset: Int) async throws -> ConversationPage {
		try await list(archived: archived, pinnedOnly: false, unreadOnly: false, limit: limit, offset: offset)
	}
}

/// Thread endpoints for one workspace.
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
	/// Ask the agents to answer again (`POST …/messages/{id}/retry`).
	func retry(conversationID: String, messageID: Int, agentID: String?) async throws
	func markRead(conversationID: String, lastMessageID: Int) async throws
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
