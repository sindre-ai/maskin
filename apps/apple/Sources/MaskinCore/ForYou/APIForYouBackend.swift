import Foundation
import MaskinAPI
import OpenAPIRuntime

/// A person or agent, resolved so cards say "from Forge", never a uuid.
public struct ForYouActor: Sendable, Equatable, Identifiable, Codable {
	public var id: String
	public var name: String
	public var isAgent: Bool
	public init(id: String, name: String, isAgent: Bool) {
		self.id = id
		self.name = name
		self.isAgent = isAgent
	}
}

/// Today's brief. Text only for now; audio playback is a later hook (`BriefSheet.onListen`).
public struct ForYouBrief: Sendable, Equatable {
	public var markdown: String
	public init(markdown: String) { self.markdown = markdown }
}

/// What `ForYouStore` reads. A protocol so the store tests without a server.
public protocol ForYouSource: Sendable {
	/// `GET /api/for-you`: the Chief of Staff's ranked list, already checked against live state.
	func fetchFeed(workspaceId: String) async throws -> [ForYouCard]
	/// `GET /api/actors`
	func fetchActors(workspaceId: String) async throws -> [ForYouActor]
	/// `GET /api/briefing`
	func fetchBrief(workspaceId: String) async throws -> ForYouBrief
}

public struct ForYouLoadError: Error, Equatable, Sendable, LocalizedError {
	public var message: String
	public init(_ message: String) { self.message = message }
	public var errorDescription: String? { message }
}

/// Production source + decision backend: the generated client behind a private adapter, so
/// operation names never leave this file. Writes translate HTTP status into the outbox's
/// retry/drop contract (4xx other than 408/429 is a permanent `OutboxRejection`).
public struct APIForYouBackend: ForYouSource, DecisionBackend {
	private let client: Client
	/// The workspace the generated client wants as a header argument. The auth middleware stamps
	/// the live one on every request regardless; this keeps the generated signature satisfied.
	private let workspaceId: @Sendable () async -> String

	public init(client: Client, workspaceId: @escaping @Sendable () async -> String) {
		self.client = client
		self.workspaceId = workspaceId
	}

	// MARK: ForYouSource

	public func fetchFeed(workspaceId ws: String) async throws -> [ForYouCard] {
		let output = try await client.get_sol_api_sol_for_hyphen_you(
			headers: .init(x_hyphen_workspace_hyphen_id: ws))
		guard case .ok(let ok) = output else { throw ForYouLoadError("Couldn't load your feed.") }
		// The list arrives in the order the Chief of Staff ranked it, so the position is the rank.
		// An item with no object to act on cannot be answered or dismissed, so it is skipped,
		// as on the web.
		return try ok.body.json.items.enumerated().compactMap { position, item in
			guard let entityId = item.entity_id, let entityType = item.entity_type else { return nil }
			// A decision card posted into a chat: answered through the chat, not as a comment.
			if let wire = item.chat_decision.flatMap({ Self.wireDecision($0) }) {
				return Self.card(
					fromChat: wire, id: entityId, entityType: entityType.rawValue, object: item.object,
					position: position)
			}
			let mention = item.latest_mention.map { m in
				ForYouMention(
					eventId: Int(m.event_id), actorId: m.actor_id,
					createdAt: Self.date(m.created_at), content: m.content,
					attention: m.attention.map { Int($0) },
					decision: m.decision.map { d in
						DecisionPrompt(
							title: d.title, summary: d.summary, ask: d.ask,
							options: d.options.map {
								DecisionOption(
									label: $0.label, consequences: $0.consequences,
									recommended: $0.recommended ?? false,
									destructive: $0.destructive ?? false)
							},
							// The server fills `body` from the draft object's current description, so a
							// draft without text (an object that is gone or empty) shows no box.
							draft: d.draft.flatMap { draft in
								guard let body = draft.body, !body.isEmpty else { return nil }
								return DecisionDraft(label: draft.label ?? "Draft", to: draft.to, body: body)
							},
							// One card, several messages. A message without text is left out and the rest stay.
							drafts: (d.drafts ?? []).compactMap { draft in
								guard let body = draft.body, !body.isEmpty else { return nil }
								return DecisionDraft(
									id: draft.id, label: draft.label ?? "Draft", to: draft.to, body: body)
							})
					})
			}
			return ForYouCard(
				id: entityId, entityType: entityType.rawValue,
				objectTitle: item.object?.title, objectType: item.object?._type,
				status: item.object?.status, unreadCount: 1,
				maxAttention: item.latest_mention?.attention.map { Int($0) },
				latestEventId: item.latest_mention.map { Int($0.event_id) },
				latestActivityAt: item.latest_mention.flatMap { Self.date($0.created_at) }
					?? item.created_at.flatMap(Self.date),
				mention: mention, rank: position)
		}
	}

	// MARK: Chat decision cards

	/// What the list says about a card in a chat. Decoded from the generated type's JSON so this
	/// file does not depend on its nested names.
	private struct WireChatDecision: Decodable {
		struct Option: Decodable {
			var label: String
			var consequences: [String]
			var recommended: Bool?
			var destructive: Bool?
		}
		struct Draft: Decodable {
			var label: String?
			var to: String?
			var body: String?
		}
		struct Decision: Decodable {
			var title: String
			var summary: String
			var ask: String
			var options: [Option]
			var draft: Draft?
		}
		struct Poster: Decodable { var id: String }
		var message_id: Double
		var conversation_id: String
		var content: String
		var decision: Decision
		var attention: Double?
		var created_at: String?
		var posted_by: Poster
	}

	private struct ObjectFields: Decodable {
		var title: String?
		var type: String?
		var status: String?
	}

	private static func wireDecision(_ value: some Encodable) -> WireChatDecision? {
		guard let data = try? JSONEncoder().encode(value) else { return nil }
		return try? JSONDecoder().decode(WireChatDecision.self, from: data)
	}

	private static func card(
		fromChat wire: WireChatDecision, id: String, entityType: String,
		object: (some Encodable)?, position: Int
	) -> ForYouCard {
		let fields = object.flatMap { try? JSONEncoder().encode($0) }
			.flatMap { try? JSONDecoder().decode(ObjectFields.self, from: $0) }
		let prompt = DecisionPrompt(
			title: wire.decision.title, summary: wire.decision.summary, ask: wire.decision.ask,
			options: wire.decision.options.map {
				DecisionOption(
					label: $0.label, consequences: $0.consequences, recommended: $0.recommended ?? false,
					destructive: $0.destructive ?? false)
			},
			draft: wire.decision.draft.flatMap { draft in
				guard let body = draft.body, !body.isEmpty else { return nil }
				return DecisionDraft(label: draft.label ?? "Draft", to: draft.to, body: body)
			})
		let created = wire.created_at.flatMap(date)
		let messageID = Int(wire.message_id)
		return ForYouCard(
			id: id, entityType: entityType, objectTitle: fields?.title, objectType: fields?.type,
			status: fields?.status, unreadCount: 1, maxAttention: wire.attention.map { Int($0) },
			// A chat card has no comment thread to mark read: answering it takes it out of the list.
			latestEventId: nil, latestActivityAt: created,
			mention: ForYouMention(
				eventId: messageID, actorId: wire.posted_by.id, createdAt: created, content: wire.content,
				attention: wire.attention.map { Int($0) }, decision: prompt),
			rank: position,
			chatDecision: ChatDecisionRef(
				conversationID: wire.conversation_id, messageID: messageID, posterID: wire.posted_by.id,
				optionLabels: wire.decision.options.map(\.label)))
	}

	public func fetchActors(workspaceId ws: String) async throws -> [ForYouActor] {
		let output = try await client.get_sol_api_sol_actors(headers: .init(x_hyphen_workspace_hyphen_id: ws))
		guard case .ok(let ok) = output else { throw ForYouLoadError("Couldn't load people.") }
		return try ok.body.json.map {
			ForYouActor(id: $0.id, name: $0.name, isAgent: $0._type == "agent")
		}
	}

	public func fetchBrief(workspaceId ws: String) async throws -> ForYouBrief {
		let output = try await client.get_sol_api_sol_briefing(
			headers: .init(x_hyphen_workspace_hyphen_id: ws))
		guard case .ok(let ok) = output else { throw ForYouLoadError("Couldn't load the brief.") }
		return ForYouBrief(markdown: try ok.body.json.markdown)
	}

	// MARK: DecisionBackend

	public func postComment(entityId: String, content: String, parentEventId: Int?) async throws {
		let ws = await workspaceId()
		let output = try await client.post_sol_api_sol_events(
			headers: .init(x_hyphen_workspace_hyphen_id: ws),
			body: .json(.init(entity_id: entityId, content: content, parent_event_id: parentEventId)))
		switch output {
		case .created: return
		case .badRequest: throw OutboxRejection(status: 400, message: "The reply was rejected.")
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	public func markRead(entityId: String, lastEventId: Int) async throws {
		let ws = await workspaceId()
		let output = try await client.post_sol_api_sol_subscriptions_sol_read(
			headers: .init(x_hyphen_workspace_hyphen_id: ws),
			body: .json(.init(entity_type: .object, entity_id: entityId, last_event_id: lastEventId)))
		switch output {
		case .ok: return
		case .notFound: throw OutboxRejection(status: 404, message: "That thread no longer exists.")
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	public func markUnread(entityId: String) async throws {
		let ws = await workspaceId()
		let output = try await client.post_sol_api_sol_subscriptions_sol_unread(
			headers: .init(x_hyphen_workspace_hyphen_id: ws),
			body: .json(.init(entity_type: .object, entity_id: entityId)))
		switch output {
		case .ok: return
		case .notFound: throw OutboxRejection(status: 404, message: "That thread no longer exists.")
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	public func answerChatDecision(
		conversationID: String, messageID: Int, optionIndex: Int, note: String?
	) async throws {
		let ws = await workspaceId()
		let output = try await client
			.put_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages_sol__lcub_messageId_rcub__sol_decision(
				.init(
					path: .init(id: conversationID, messageId: messageID),
					headers: .init(x_hyphen_workspace_hyphen_id: ws),
					body: .json(.init(option_index: optionIndex, note: note))))
		switch output {
		case .ok: return
		// Someone else answered first, or it was withdrawn: either way the card is gone.
		case .conflict: return
		case .forbidden: throw OutboxRejection(status: 403, message: "This decision isn't addressed to you.")
		case .notFound: throw OutboxRejection(status: 404, message: "That decision no longer exists.")
		case .badRequest: throw OutboxRejection(status: 400, message: "That option isn't on this decision.")
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	public func replyToChatDecision(
		conversationID: String, messageID: Int, text: String, mention: String?
	) async throws {
		let ws = await workspaceId()
		let output = try await client.post_sol_api_sol_conversations_sol__lcub_id_rcub__sol_messages(
			.init(
				path: .init(id: conversationID),
				headers: .init(x_hyphen_workspace_hyphen_id: ws),
				body: .json(
					.init(
						content: text, metadata: mention.map { .init(mentions: [$0]) },
						thread_root_id: messageID, also_in_channel: true))))
		switch output {
		case .created: return
		case .notFound: throw OutboxRejection(status: 404, message: "That decision no longer exists.")
		case .badRequest: throw OutboxRejection(status: 400, message: "The reply was rejected.")
		case .undocumented(let status, _): throw Self.failure(status: status)
		}
	}

	private static func failure(status: Int) -> any Error {
		if OutboxRejection.isAuthFailure(status: status) { return OutboxAuthRequired(status: status) }
		if OutboxRejection.isPermanent(status: status) {
			return OutboxRejection(status: status, message: "The server rejected this (\(status)).")
		}
		return URLError(.badServerResponse)
	}

	private static func date(_ s: String) -> Date? {
		let f = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
		return (try? f.parse(s)) ?? (try? Date.ISO8601FormatStyle().parse(s))
	}
}
