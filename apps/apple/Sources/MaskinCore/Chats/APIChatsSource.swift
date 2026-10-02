import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production sources for the Chats stores. The generated client's operation names stay inside
/// this file; everything above sees `ChatsAPI.swift` protocols and plain models.
public struct APIChatsSource: ConversationsAPI, ChatAPI {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	// MARK: - List

	public func list(archived: Bool, limit: Int, offset: Int) async throws -> ConversationPage {
		let output = try await client.get_sol_api_sol_conversations(
			.init(
				query: .init(archived: archived, limit: limit, offset: offset),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			let body = try ok.body.json
			return ConversationPage(
				conversations: body.conversations.map { row in
					ConversationSummary(
						id: row.id, title: row.title, lastMessageAt: ChatDates.parse(row.lastMessageAt),
						createdAt: ChatDates.parse(row.createdAt), pinned: row.pinned,
						archived: row.archived, unreadCount: Int(row.unread_count), snippet: row.snippet,
						snippetActorName: row.snippet_actor_name,
						participants: row.participants.map {
							ChatParticipant(id: $0.actorId, name: $0.actorName, actorType: $0.actorType)
						})
				},
				hasMore: body.has_more)
		default:
			throw ChatsError("Couldn't load conversations.")
		}
	}

	public func create(
		title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String
	) async throws -> ConversationSummary {
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_conversations(
				.init(
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(
						.init(
							title: title, participant_actor_ids: participantIDs,
							initial_message: initialMessage))))
		}
		switch output {
		case .created(let created):
			let row = try created.body.json
			return ConversationSummary(
				id: row.id, title: row.title, lastMessageAt: ChatDates.parse(row.lastMessageAt),
				createdAt: ChatDates.parse(row.createdAt), pinned: row.pinned, archived: row.archived,
				unreadCount: Int(row.unread_count),
				participants: row.participants.map {
					ChatParticipant(id: $0.actorId, name: $0.actorName, actorType: $0.actorType)
				}, lastReadMessageID: row.last_read_message_id.map(Int.init))
		default:
			throw ChatsError("Couldn't start the conversation.")
		}
	}

	public func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?,
		markUnread: Bool
	) async throws {
		let output = try await client.patch_sol_api_sol_conversations_sol__lcub_id_rcub__sol_me(
			.init(
				path: .init(id: conversationID),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(
					.init(
						pinned: pinned, archived: archived, last_read_message_id: lastReadMessageID,
						mark_unread: markUnread ? true : nil))))
		guard case .ok = output else { throw ChatsError("Couldn't update the conversation.") }
	}

	public func actors() async throws -> [ChatActor] {
		var all: [ChatActor] = []
		var offset = 0
		let pageSize = 100
		while offset < 500 {
			let output = try await client.get_sol_api_sol_actors(
				.init(
					query: .init(limit: pageSize, offset: offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .ok(let ok) = output else { throw ChatsError("Couldn't load people and agents.") }
			let rows = try ok.body.json
			all += rows.map { row in
				ChatActor(
					participant: ChatParticipant(id: row.id, name: row.name, actorType: row._type),
					agentState: ChatActor.AgentState(rawValue: row.agentState.rawValue) ?? .unknown,
					summary: row.description, isSystem: row.isSystem)
			}
			if rows.count < pageSize { break }
			offset += pageSize
		}
		return all
	}

	// MARK: - Thread

	public func detail(conversationID: String) async throws -> ConversationSummary {
		let output = try await client.get_sol_api_sol_conversations_sol__lcub_id_rcub_(
			.init(
				path: .init(id: conversationID),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			let row = try ok.body.json
			return ConversationSummary(
				id: row.id, title: row.title, lastMessageAt: ChatDates.parse(row.lastMessageAt),
				createdAt: ChatDates.parse(row.createdAt), pinned: row.pinned, archived: row.archived,
				unreadCount: Int(row.unread_count),
				participants: row.participants.map {
					ChatParticipant(id: $0.actorId, name: $0.actorName, actorType: $0.actorType)
				}, lastReadMessageID: row.last_read_message_id.map(Int.init))
		default:
			throw ChatsError("Couldn't open this conversation.")
		}
	}

	public func messages(
		conversationID: String, beforeID: Int?, afterID: Int?, limit: Int
	) async throws -> MessagePage {
		let output = try await client.get_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages(
			.init(
				path: .init(id: conversationID),
				query: .init(before_id: beforeID, after_id: afterID, limit: limit),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			let body = try ok.body.json
			let messages = body.messages.map { row in
				ChatMessage.confirmed(
					serverID: Int(row.id), conversationID: row.conversationId, actorID: row.actorId,
					actorName: row.actorName, author: row.actorType == "agent" ? .agent : .human,
					kind: row.kind, content: row.content, createdAt: ChatDates.parse(row.createdAt),
					editedAt: ChatDates.parse(row.editedAt), metadata: Self.json(row.metadata))
			}
			return MessagePage(messages: messages.sorted { ($0.serverID ?? 0) < ($1.serverID ?? 0) }, hasMore: body.has_more)
		default:
			throw ChatsError("Couldn't load messages.")
		}
	}

	public func send(conversationID: String, content: String, idempotencyKey: String) async throws
		-> ChatMessage
	{
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages(
				.init(
					path: .init(id: conversationID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(.init(content: content))))
		}
		switch output {
		case .created(let created):
			let row = try created.body.json
			return ChatMessage.confirmed(
				serverID: Int(row.id), conversationID: row.conversationId, actorID: row.actorId,
				actorName: row.actorName, author: row.actorType == "agent" ? .agent : .human,
				kind: row.kind, content: row.content, createdAt: ChatDates.parse(row.createdAt),
				editedAt: ChatDates.parse(row.editedAt), metadata: Self.json(row.metadata))
		default:
			throw ChatsError("Couldn't send the message.")
		}
	}

	public func retry(conversationID: String, messageID: Int, agentID: String?) async throws {
		let output = try await client
			.post_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_retry(
				.init(
					path: .init(id: conversationID, messageId: messageID),
					query: .init(agent_id: agentID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .accepted = output else { throw ChatsError("Couldn't ask the agents to try again.") }
	}

	public func markRead(conversationID: String, lastMessageID: Int) async throws {
		try await updateState(
			conversationID: conversationID, pinned: nil, archived: nil, lastReadMessageID: lastMessageID,
			markUnread: false)
	}

	public func addParticipants(conversationID: String, actorIDs: [String]) async throws {
		let output = try await client.post_sol_api_sol_conversations_sol__lcub_id_rcub__sol_participants(
			.init(
				path: .init(id: conversationID),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(.init(actor_ids: actorIDs))))
		guard case .ok = output else { throw ChatsError("Couldn't add people.") }
	}

	private static func json(_ container: (any Encodable)?) -> JSONValue? {
		guard let container, let data = try? JSONEncoder().encode(container) else { return nil }
		return try? JSONDecoder().decode(JSONValue.self, from: data)
	}
}
