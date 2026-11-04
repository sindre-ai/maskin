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
							// The server fills `body` from the draft object's current description. A draft
							// with neither text nor a file (an object that is gone or empty) shows no box.
							draft: d.draft.flatMap { Self.draft($0, fallbackLabel: "Draft") },
							// One card, several messages. One with neither text nor file is left out
							// and the rest stay.
							drafts: (d.drafts ?? []).compactMap { Self.draft($0, fallbackLabel: "Draft") })
					})
			}
			return ForYouCard(
				id: entityId, entityType: entityType.rawValue,
				objectTitle: item.object?.title, objectType: item.object?._type,
				status: item.object?.status, unreadCount: 1,
				maxAttention: item.latest_mention?.attention.map { Int($0) },
				// A curated item with no source comment has no `latest_mention`; the server then puts
				// the newest activity on the object in `latest_event_id`. Same fallback as the web.
				// Without it a swipe to mark read has nothing to mark and the card springs back.
				latestEventId: item.latest_mention.map { Int($0.event_id) }
					?? item.latest_event_id.map { Int($0) },
				latestActivityAt: item.latest_mention.flatMap { Self.date($0.created_at) }
					?? item.created_at.flatMap(Self.date),
				mention: mention, rank: position)
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

	/// Maps a feed draft (the card's single one or one of several: the generated types differ but
	/// have the same JSON shape) to the app's model. Nil when it has neither text nor a file.
	static func draft<T: Encodable>(_ raw: T, fallbackLabel: String) -> DecisionDraft? {
		guard let data = try? JSONEncoder().encode(raw),
			let dto = try? JSONDecoder().decode(FeedDraftDTO.self, from: data)
		else { return nil }
		return dto.model(fallbackLabel: fallbackLabel)
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

/// The JSON of a draft in the feed, read once into plain values so the single `draft` and each
/// entry of `drafts` map the same way.
struct FeedDraftDTO: Decodable {
	struct Recipient: Decodable { var role: String; var name: String?; var address: String? }
	struct Detail: Decodable { var label: String; var value: String }
	struct Delivery: Decodable { var state: String }
	struct Preview: Decodable {
		var kind: String
		var label: String
		var recipients: [Recipient]?
		var subject: String?
		var details: [Detail]?
		var body: String
		var missing: [String]?
		var warnings: [String]?
		var content_hash: String
		var delivery: Delivery?
	}
	struct File: Decodable {
		var id: String
		var name: String
		var mime_type: String
		var size_bytes: Double
	}
	var id: String?
	var object_id: String?
	var label: String?
	var to: String?
	var body: String?
	var preview: Preview?
	var file: File?

	func model(fallbackLabel: String) -> DecisionDraft? {
		let text = body ?? ""
		let fileReference = file.map {
			FileReference(
				id: $0.id, name: $0.name, mimeType: $0.mime_type,
				sizeBytes: $0.size_bytes.isFinite ? Int(max(0, min($0.size_bytes, Double(Int32.max)))) : 0)
		}
		guard !text.isEmpty || fileReference != nil else { return nil }
		let objectPreview = preview.map { p in
			ObjectPreview(
				kind: p.kind, label: p.label,
				recipients: (p.recipients ?? []).map {
					.init(role: $0.role, name: $0.name, address: $0.address)
				},
				subject: p.subject,
				details: (p.details ?? []).map { .init(label: $0.label, value: $0.value) },
				body: p.body, missing: p.missing ?? [], warnings: p.warnings ?? [],
				contentHash: p.content_hash,
				delivery: p.delivery.flatMap { ObjectPreview.Delivery(rawValue: $0.state) })
		}
		return DecisionDraft(
			id: id, label: label ?? objectPreview?.label ?? fallbackLabel, to: to, body: text,
			objectId: object_id, preview: objectPreview, file: fileReference)
	}
}
