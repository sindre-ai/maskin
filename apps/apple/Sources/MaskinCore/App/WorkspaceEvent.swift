import Foundation
import MaskinAPI

/// What an event is about. Open set: the backend adds entity types without a client release, so
/// an unknown value is just another `EntityType`, never a decode failure.
public struct EntityType: RawRepresentable, Hashable, Sendable, ExpressibleByStringLiteral {
	public let rawValue: String
	public init(rawValue: String) { self.rawValue = rawValue }
	public init(stringLiteral value: String) { rawValue = value }

	/// Insights, bets, tasks and every other row of the unified `objects` table.
	public static let object: EntityType = "object"
	public static let actor: EntityType = "actor"
	public static let session: EntityType = "session"
	public static let trigger: EntityType = "trigger"
	public static let conversation: EntityType = "conversation"
	public static let notification: EntityType = "notification"
	public static let relationship: EntityType = "relationship"
	public static let file: EntityType = "file"
	public static let workspace: EntityType = "workspace"
}

/// One row of the workspace's `events` table (audit log + real-time feed), as pushed over
/// `GET /api/events`.
///
/// The live push carries only identifiers (`data` is dropped server-side to stay under the PG
/// NOTIFY 8 KB limit), so treat an event as "this entity changed, refetch it". The replay after
/// a reconnect carries full rows including `data`. Both shapes decode here.
public struct WorkspaceEvent: Sendable, Equatable, Identifiable {
	/// The events-table id, as a string (the SSE `id:` that drives `Last-Event-ID`).
	public var id: String
	public var workspaceId: String?
	/// The actor who caused it; `nil` for system events.
	public var actorId: String?
	/// `created`, `updated`, `deleted`, and domain verbs like `status_changed`. Open set.
	public var action: String
	public var entityType: EntityType
	public var entityId: String?
	/// Only present on replayed rows, not on live pushes. May be any shape.
	public var data: JSONValue?
	public var createdAt: Date?

	public init(
		id: String, workspaceId: String? = nil, actorId: String? = nil, action: String,
		entityType: EntityType, entityId: String? = nil, data: JSONValue? = nil,
		createdAt: Date? = nil
	) {
		self.id = id
		self.workspaceId = workspaceId
		self.actorId = actorId
		self.action = action
		self.entityType = entityType
		self.entityId = entityId
		self.data = data
		self.createdAt = createdAt
	}
}

extension WorkspaceEvent {
	/// Tolerant decode of one SSE frame. Accepts the live shape (`snake_case`, `event_id`) and the
	/// replay shape (`camelCase`, numeric `id`), ignores unknown fields, and returns `nil` rather
	/// than throwing for anything that isn't an event object, so one odd frame never kills the
	/// stream.
	public init?(sse: SSEEvent) {
		guard let raw = sse.data.data(using: .utf8),
			let json = try? JSONDecoder().decode([String: JSONValue].self, from: raw)
		else { return nil }

		func string(_ keys: String...) -> String? {
			for key in keys {
				switch json[key] {
				case .string(let s): return s
				case .number(let n): return n.rounded() == n ? String(Int(n)) : String(n)
				default: continue
				}
			}
			return nil
		}

		guard let entityType = string("entity_type", "entityType") else { return nil }
		guard let id = string("event_id", "id") ?? sse.id else { return nil }

		var data: JSONValue?
		if let value = json["data"], value != .null { data = value }

		self.init(
			id: id,
			workspaceId: string("workspace_id", "workspaceId"),
			actorId: string("actor_id", "actorId"),
			action: string("action") ?? sse.event,
			entityType: EntityType(rawValue: entityType),
			entityId: string("entity_id", "entityId"),
			data: data,
			createdAt: string("created_at", "createdAt").flatMap(Self.parseDate)
		)
	}

	private static func parseDate(_ s: String) -> Date? {
		let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
		return (try? withFraction.parse(s)) ?? (try? Date.ISO8601FormatStyle().parse(s))
	}
}
