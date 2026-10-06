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

	public func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int)
		async throws -> ConversationPage
	{
		let output = try await client.get_sol_api_sol_conversations(
			.init(
				// The server parses `?archived=false` with `z.coerce.boolean()`, which reads the string
				// "false" as true and returns the ARCHIVED list. Omit it for the default (active) list.
				query: .init(
					pinned: pinnedOnly ? true : nil, archived: archived ? true : nil,
					unread_only: unreadOnly ? true : nil, limit: min(limit, ChatLimits.maxConversationsPage),
					offset: offset),
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

	public func send(
		conversationID: String, content: String, metadata: ChatSendMetadata?, idempotencyKey: String
	) async throws -> ChatMessage {
		let wireMetadata = try metadata.flatMap { value -> Metadata? in
			guard !value.isEmpty else { return nil }
			// Round-trip through JSON: ChatSendMetadata already uses the API's exact keys, so the
			// generated payload type decodes it without a field-by-field copy.
			return try JSONDecoder().decode(Metadata.self, from: JSONEncoder().encode(value))
		}
		let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
			try await client.post_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages(
				.init(
					path: .init(id: conversationID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(.init(content: content, metadata: wireMetadata))))
		}
		switch output {
		case .created(let created):
			let row = try created.body.json
			return ChatMessage.confirmed(
				serverID: Int(row.id), conversationID: row.conversationId, actorID: row.actorId,
				actorName: row.actorName, author: row.actorType == "agent" ? .agent : .human,
				kind: row.kind, content: row.content, createdAt: ChatDates.parse(row.createdAt),
				editedAt: ChatDates.parse(row.editedAt), metadata: Self.json(row.metadata))
		case .notFound:
			throw ChatsHTTPError(status: 404, message: "This conversation no longer exists.")
		case .undocumented(let status, _):
			throw ChatsHTTPError(status: status, message: "Couldn't send the message.")
		}
	}

	private typealias Metadata = Operations
		.post_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages.Input.Body.jsonPayload
		.metadataPayload

	public func retry(conversationID: String, messageID: Int, agentID: String?) async throws {
		let output = try await client
			.post_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_retry(
				.init(
					path: .init(id: conversationID, messageId: messageID),
					query: .init(agent_id: agentID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .accepted = output else { throw ChatsError("Couldn't ask the agents to try again.") }
	}

	public func edit(conversationID: String, messageID: Int, content: String) async throws -> ChatMessage {
		let output = try await client
			.patch_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub_(
				.init(
					path: .init(id: conversationID, messageId: messageID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(.init(content: content))))
		switch output {
		case .ok(let ok):
			let row = try ok.body.json
			return ChatMessage.confirmed(
				serverID: Int(row.id), conversationID: row.conversationId, actorID: row.actorId,
				actorName: row.actorName, author: row.actorType == "agent" ? .agent : .human,
				kind: row.kind, content: row.content, createdAt: ChatDates.parse(row.createdAt),
				editedAt: ChatDates.parse(row.editedAt), metadata: Self.json(row.metadata))
		case .forbidden:
			throw ChatsHTTPError(status: 403, message: "Only the author can edit a message.")
		case .undocumented(let status, _):
			throw ChatsHTTPError(status: status, message: "Couldn't save the edit.")
		default:
			throw ChatsHTTPError(status: 404, message: "That message no longer exists.")
		}
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

	public func removeParticipant(conversationID: String, actorID: String) async throws {
		let output = try await client
			.delete_sol_api_sol_conversations_sol__lcub_id_rcub__sol_participants_sol__lcub_actorId_rcub_(
				.init(
					path: .init(id: conversationID, actorId: actorID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .noContent: return
		case .forbidden: throw ChatsError("You can't remove that person.")
		default: throw ChatsError("Couldn't remove that person.")
		}
	}

	public func rename(conversationID: String, title: String) async throws {
		let output = try await client.patch_sol_api_sol_conversations_sol__lcub_id_rcub_(
			.init(
				path: .init(id: conversationID),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(.init(title: title))))
		guard case .ok = output else { throw ChatsError("Couldn't rename the conversation.") }
	}

	// MARK: - Sessions

	public func sessions(conversationID: String) async throws -> [ChatAgentSession] {
		let output = try await client.get_sol_api_sol_sessions(
			.init(
				query: .init(conversation_id: conversationID, verbose: true, limit: 50),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw ChatsError("Couldn't check on the agents.") }
		// verbose=true asks for the full rows (the default is the lean list shape).
		return (try ok.body.json.value1 ?? []).map { row in
			let config = Self.json(row.config)
			return ChatAgentSession(
				id: row.id, actorID: row.actorId, status: .init(row.status),
				currentActivity: row.currentActivity, startedAt: ChatDates.parse(row.startedAt),
				updatedAt: ChatDates.parse(row.updatedAt),
				messageID: config?["conversation"]?["message_id"]?.intValue)
		}
	}

	public func stopSession(sessionID: String) async throws {
		let output = try await client.post_sol_api_sol_sessions_sol__lcub_id_rcub__sol_stop(
			.init(
				path: .init(id: sessionID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok = output else { throw ChatsError("Couldn't stop the agent.") }
	}

	public func resumeSession(sessionID: String) async throws {
		let output = try await client.post_sol_api_sol_sessions_sol__lcub_id_rcub__sol_resume(
			.init(
				path: .init(id: sessionID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok = output else { throw ChatsError("Couldn't resume the agent.") }
	}

	private static func json(_ container: (any Encodable)?) -> JSONValue? {
		guard let container, let data = try? JSONEncoder().encode(container) else { return nil }
		return try? JSONDecoder().decode(JSONValue.self, from: data)
	}
}

extension APIChatsSource: ChatFileUploading {
	public func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
		let output = try await client.post_sol_api_sol_files(
			.init(
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(
					.init(
						name: name, mime_type: mimeType, content: data.base64EncodedString(),
						encoding: .base64))))
		switch output {
		case .created(let created):
			let row = try created.body.json
			return ChatAttachmentRef(
				fileID: row.id, name: row.name, mimeType: row.mimeType, sizeBytes: Int(row.sizeBytes))
		case .badRequest:
			throw ChatsError("That file can't be attached.")
		default:
			throw ChatsError("Couldn't upload the file.")
		}
	}
}
