import Foundation

/// Conversation-list endpoints. A protocol so `ConversationsStore` tests without a server.
public protocol ConversationsAPI: Sendable {
	func list(archived: Bool, limit: Int, offset: Int) async throws -> ConversationPage
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

/// Thread endpoints for one workspace.
public protocol ChatAPI: Sendable {
	func detail(conversationID: String) async throws -> ConversationSummary
	/// Newest page first server-side; returned oldest-first here. `beforeID` pages into the past,
	/// `afterID` fetches only what is newer than a known message.
	func messages(
		conversationID: String, beforeID: Int?, afterID: Int?, limit: Int
	) async throws -> MessagePage
	func send(conversationID: String, content: String, idempotencyKey: String) async throws
		-> ChatMessage
	/// Ask the agents to answer again (`POST …/messages/{id}/retry`).
	func retry(conversationID: String, messageID: Int, agentID: String?) async throws
	func markRead(conversationID: String, lastMessageID: Int) async throws
	func addParticipants(conversationID: String, actorIDs: [String]) async throws
	func actors() async throws -> [ChatActor]
}
