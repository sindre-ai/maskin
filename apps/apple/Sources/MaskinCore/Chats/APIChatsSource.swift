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
						snippetActorName: row.snippet_actor_name, snippetActorID: row.snippet_actor_id,
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

	public func latestMessageID(conversationID: String) async throws -> Int? {
		try await messages(conversationID: conversationID, beforeID: nil, afterID: nil, limit: 1)
			.messages.last?.serverID
	}

	public func messages(
		conversationID: String, beforeID: Int?, afterID: Int?, limit: Int
	) async throws -> MessagePage {
		try await fetchMessages(
			conversationID: conversationID, beforeID: beforeID, afterID: afterID, limit: limit, rootID: nil)
	}

	public func threadReplies(conversationID: String, rootID: Int) async throws -> [ChatMessage] {
		var all: [ChatMessage] = []
		var before: Int?
		// A thread rarely passes one page; the loop keeps a long one whole.
		for _ in 0..<5 {
			let page = try await fetchMessages(
				conversationID: conversationID, beforeID: before, afterID: nil,
				limit: ChatLimits.maxMessagesPage, rootID: rootID)
			all = page.messages + all
			guard page.hasMore, let oldest = page.messages.first?.serverID else { break }
			before = oldest
		}
		return all
	}

	private func fetchMessages(
		conversationID: String, beforeID: Int?, afterID: Int?, limit: Int, rootID: Int?
	) async throws -> MessagePage {
		let output = try await client.get_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages(
			.init(
				path: .init(id: conversationID),
				query: .init(before_id: beforeID, after_id: afterID, limit: limit, thread_root_id: rootID),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			let body = try ok.body.json
			let messages = body.messages.map { row in
				var message = ChatMessage.confirmed(
					serverID: Int(row.id), conversationID: row.conversationId, actorID: row.actorId,
					actorName: row.actorName, author: row.actorType == "agent" ? .agent : .human,
					kind: row.kind, content: row.content, createdAt: ChatDates.parse(row.createdAt),
					editedAt: ChatDates.parse(row.editedAt), metadata: Self.json(row.metadata),
					spawnedSessions: (row.spawned_sessions ?? []).map(Self.spawned),
					threadRootID: row.threadRootId.map { Int($0) }, alsoInChannel: row.threadAlsoInChannel)
				message.thread = Self.json(row.thread).flatMap(Self.summary)
				message.reactions = Self.reactions(Self.json(row.reactions))
				return message
			}
			return MessagePage(messages: messages.sorted { ($0.serverID ?? 0) < ($1.serverID ?? 0) }, hasMore: body.has_more)
		default:
			throw ChatsError("Couldn't load messages.")
		}
	}

	public func threads(limit: Int) async throws -> [ThreadListItem] {
		let output = try await client.get_sol_api_sol_conversations_sol_threads(
			.init(
				query: .init(limit: min(limit, 100)),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw ChatsError("Couldn't load threads.") }
		return try ok.body.json.threads.compactMap { row in
			guard let item = Self.json(row), let root = item["root"], let thread = item["thread"],
				let summary = Self.summary(thread), let rootMessage = Self.message(root)
			else { return nil }
			return ThreadListItem(
				conversationID: row.conversationId, conversationTitle: row.conversationTitle,
				root: rootMessage, summary: summary, lastReply: item["lastReply"].flatMap(Self.message))
		}
	}

	public func react(conversationID: String, messageID: Int, emoji: String, add: Bool) async throws {
		let path = Operations
			.put_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_reactions
			.Input.Path(id: conversationID, messageId: messageID)
		let headers = Operations
			.put_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_reactions
			.Input.Headers(x_hyphen_workspace_hyphen_id: workspaceID)
		if add {
			let output = try await client
				.put_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_reactions(
					.init(path: path, headers: headers, body: .json(.init(emoji: emoji))))
			guard case .noContent = output else { throw ChatsError("Couldn't add the reaction.") }
		} else {
			let output = try await client
				.delete_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_reactions(
					.init(
						path: .init(id: conversationID, messageId: messageID),
						query: .init(emoji: emoji),
						headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .noContent = output else { throw ChatsError("Couldn't remove the reaction.") }
		}
	}

	private static func reactions(_ value: JSONValue?) -> [MessageReaction] {
		value?.arrayValue?.compactMap { item in
			guard let emoji = item["emoji"]?.stringValue, let count = item["count"]?.intValue else { return nil }
			let people: [ChatParticipant] = item["actors"]?.arrayValue?.compactMap { actor in
				guard let id = actor["actorId"]?.stringValue else { return nil }
				return ChatParticipant(id: id, name: actor["actorName"]?.stringValue ?? "", kind: .human)
			} ?? []
			return MessageReaction(
				emoji: emoji, count: count, reactedByMe: item["reactedByMe"]?.boolValue ?? false, people: people)
		} ?? []
	}

	public func markThreadRead(conversationID: String, rootID: Int, lastMessageID: Int) async throws {
		let output = try await client
			.put_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_thread_sol_read(
				.init(
					path: .init(id: conversationID, messageId: rootID),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
					body: .json(.init(last_read_message_id: lastMessageID))))
		guard case .ok = output else { throw ChatsError("Couldn't mark the thread read.") }
	}

	/// A message row (list item, send result) as the app's model, read from its JSON form.
	private static func message(_ value: JSONValue) -> ChatMessage? {
		guard let id = value["id"]?.intValue, let conversationID = value["conversationId"]?.stringValue,
			let actorID = value["actorId"]?.stringValue
		else { return nil }
		return ChatMessage.confirmed(
			serverID: id, conversationID: conversationID, actorID: actorID,
			actorName: value["actorName"]?.stringValue ?? "",
			author: value["actorType"]?.stringValue == "agent" ? .agent : .human,
			kind: value["kind"]?.stringValue ?? "message", content: value["content"]?.stringValue ?? "",
			createdAt: ChatDates.parse(value["createdAt"]?.stringValue),
			editedAt: ChatDates.parse(value["editedAt"]?.stringValue),
			metadata: value["metadata"] == .null ? nil : value["metadata"],
			threadRootID: value["threadRootId"]?.intValue,
			alsoInChannel: value["threadAlsoInChannel"]?.boolValue ?? false)
	}

	private static func summary(_ value: JSONValue) -> ThreadSummary? {
		guard let count = value["replyCount"]?.intValue, let last = value["lastReplyId"]?.intValue else { return nil }
		let people: [ChatParticipant] = value["participants"]?.arrayValue?.compactMap { person in
			guard let id = person["actorId"]?.stringValue else { return nil }
			return ChatParticipant(
				id: id, name: person["actorName"]?.stringValue ?? "",
				actorType: person["actorType"]?.stringValue ?? "human")
		} ?? []
		return ThreadSummary(
			replyCount: count, unreadCount: value["unreadCount"]?.intValue ?? 0, lastReplyID: last,
			lastReplyAt: ChatDates.parse(value["lastReplyAt"]?.stringValue), participants: people)
	}

	public func send(
		conversationID: String, content: String, metadata: ChatSendMetadata?, idempotencyKey: String
	) async throws -> ChatMessage {
		try await send(
			conversationID: conversationID, content: content, metadata: metadata, thread: nil,
			idempotencyKey: idempotencyKey)
	}

	public func send(
		conversationID: String, content: String, metadata: ChatSendMetadata?, thread: ChatSendThread?,
		idempotencyKey: String
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
					body: .json(
						.init(
							content: content, metadata: wireMetadata, thread_root_id: thread?.rootID,
							also_in_channel: thread?.alsoInChannel == true ? true : nil))))
		}
		switch output {
		case .created(let created):
			let row = try created.body.json
			return ChatMessage.confirmed(
				serverID: Int(row.id), conversationID: row.conversationId, actorID: row.actorId,
				actorName: row.actorName, author: row.actorType == "agent" ? .agent : .human,
				kind: row.kind, content: row.content, createdAt: ChatDates.parse(row.createdAt),
				editedAt: ChatDates.parse(row.editedAt), metadata: Self.json(row.metadata),
				threadRootID: row.threadRootId.map { Int($0) }, alsoInChannel: row.threadAlsoInChannel)
		case .badRequest(let bad):
			// A pasted secret that got past the app's own check (it is refused on the server too).
			let code = (try? bad.body.json)?.error.code
			throw ChatsHTTPError(
				status: 400,
				message: code == "RAW_SECRET_DETECTED"
					? "That message looks like it contains a secret, so it wasn't sent. Cut the secret out, or save it to the Keychain."
					: "The message was rejected.")
		case .notFound:
			throw ChatsHTTPError(
				status: 404,
				message: thread == nil
					? "This conversation no longer exists." : "That thread's first message is gone.")
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

	private static func spawned(
		_ row: Operations.get_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages.Output.Ok.Body
			.jsonPayload.messagesPayloadPayload.spawned_sessionsPayloadPayload
	) -> SpawnedSession {
		let pill = SpawnedSession(
			id: row.id, status: row.status, actorID: row.actorId, actorName: row.actorName,
			actionPrompt: row.actionPrompt
		).pill
		return SpawnedSession(
			id: row.id, status: row.status, actorID: row.actorId, actorName: row.actorName,
			actionPrompt: row.actionPrompt, startedAt: ChatDates.parse(row.startedAt),
			completedAt: ChatDates.parse(row.completedAt), durationMs: row.durationMs,
			outcomeText: SpawnedSession.outcome(from: Self.json(row.result), pill: pill),
			currentActivity: row.currentActivity, dependsOn: row.depends_on_session_ids)
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
