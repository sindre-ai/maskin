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
	/// `GET /api/subscriptions/unread?include_recently_read=…`
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
		let output = try await client.get_sol_api_sol_subscriptions_sol_unread(
			query: .init(entity_type: .object, include_recently_read: ._false),
			headers: .init(x_hyphen_workspace_hyphen_id: ws))
		guard case .ok(let ok) = output else { throw ForYouLoadError("Couldn't load your feed.") }
		return try ok.body.json.items.map { item in
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
									recommended: $0.recommended ?? false)
							})
					})
			}
			return ForYouCard(
				id: item.entity_id, entityType: item.entity_type,
				objectTitle: item.object?.title, objectType: item.object?._type,
				status: item.object?.status, unreadCount: Int(item.unread_count),
				maxAttention: item.max_unread_attention.map { Int($0) },
				latestEventId: item.latest_event_id.map { Int($0) },
				latestActivityAt: item.latest_activity_at.flatMap(Self.date), mention: mention)
		}
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
