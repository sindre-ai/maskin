import Foundation

/// One row of the unified `objects` table: an insight, bet, task, or any custom type a workspace
/// defines. Every field the screens read is here as a plain value.
public struct WorkObject: Identifiable, Sendable, Equatable, Hashable, Codable {
	public var id: String
	public var type: String
	public var title: String?
	public var content: String?
	public var status: String
	/// Scalar metadata fields only (strings, numbers, bools). Nested values are dropped.
	public var metadata: [String: String]
	/// The actor driving this object (the "owner" in the UI).
	public var driverId: String?
	public var createdBy: String?
	public var createdAt: Date?
	public var updatedAt: Date?
	public var isStarred: Bool
	public var unreadCount: Int
	/// What an agent session on this object is doing right now, when one is active.
	public var activeActivity: String?
	/// An agent session is running on this object, whether or not it has reported an activity.
	public var hasActiveSession: Bool
	/// The newest agent session started for this object (`last_session`), nil when none or not readable.
	public var lastSession: ObjectSession?

	public init(
		id: String, type: String, title: String? = nil, content: String? = nil, status: String,
		metadata: [String: String] = [:], driverId: String? = nil, createdBy: String? = nil,
		createdAt: Date? = nil, updatedAt: Date? = nil, isStarred: Bool = false,
		unreadCount: Int = 0, activeActivity: String? = nil, hasActiveSession: Bool = false
	) {
		self.id = id
		self.type = type
		self.title = title
		self.content = content
		self.status = status
		self.metadata = metadata
		self.driverId = driverId
		self.createdBy = createdBy
		self.createdAt = createdAt
		self.updatedAt = updatedAt
		self.isStarred = isStarred
		self.unreadCount = unreadCount
		self.activeActivity = activeActivity
		self.hasActiveSession = hasActiveSession || !(activeActivity ?? "").isEmpty
	}

	/// Never empty and never an id.
	public var displayTitle: String {
		let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? "Untitled" : trimmed
	}
}

/// `last_session` on an object read: who ran, how it ended, and where it started. Plain values;
/// ids resolve to names through the actor directory, never shown as they are.
public struct ObjectSession: Sendable, Equatable, Hashable, Codable {
	public var id: String
	public var status: String
	public var agentID: String
	public var startedAt: Date?
	/// Short reason, set by the server only when the session failed.
	public var failureReason: String?
	public var chatID: String?
	public var createdByActorID: String?

	public init(
		id: String, status: String, agentID: String, startedAt: Date? = nil, failureReason: String? = nil,
		chatID: String? = nil, createdByActorID: String? = nil
	) {
		self.id = id
		self.status = status
		self.agentID = agentID
		self.startedAt = startedAt
		self.failureReason = failureReason
		self.chatID = chatID
		self.createdByActorID = createdByActorID
	}

	public var isFailed: Bool { status == "failed" || status == "timeout" }
	public var isLive: Bool { AgentSession.activeStatuses.contains(status) || status == "paused" }
}

/// How another object is linked to the one on screen, read from the viewing object's side.
public struct ObjectLink: Identifiable, Sendable, Equatable, Hashable, Codable {
	public var id: String
	/// `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`, or any custom type.
	public var relation: String
	/// `true` when the viewed object is the edge's source (it "blocks X"), `false` when it is the
	/// target (it "is blocked by X").
	public var isOutgoing: Bool
	public var otherId: String
	public var otherType: String
	public var otherTitle: String
	public var otherStatus: String?
	/// The actor driving the other object (its owner), when the graph carries it.
	public var otherDriver: String?

	public init(
		id: String, relation: String, isOutgoing: Bool, otherId: String, otherType: String,
		otherTitle: String, otherStatus: String? = nil, otherDriver: String? = nil
	) {
		self.id = id
		self.relation = relation
		self.isOutgoing = isOutgoing
		self.otherId = otherId
		self.otherType = otherType
		self.otherTitle = otherTitle
		self.otherStatus = otherStatus
		self.otherDriver = otherDriver
	}

	/// "blocks", "blocked by", "informs", "informed by", "relates to"...
	public var phrase: String {
		let base = relation.replacingOccurrences(of: "_", with: " ")
		if isOutgoing { return base }
		switch relation {
		case "blocks": return "blocked by"
		case "informs": return "informed by"
		case "breaks_into": return "part of"
		case "duplicates": return "duplicated by"
		default: return base
		}
	}
}

/// One edge of the object's graph, as much of it as the origin needs.
public struct OriginEdge: Sendable, Equatable {
	public var type: String
	public var sourceType: String
	public var sourceId: String
	public var targetType: String
	public var targetId: String
	/// Who wrote the edge: for a `produced_by` edge, the agent that ran the session.
	public var createdBy: String?
	public var createdAt: Date?

	public init(
		type: String, sourceType: String, sourceId: String, targetType: String, targetId: String,
		createdBy: String? = nil, createdAt: Date? = nil
	) {
		self.type = type
		self.sourceType = sourceType
		self.sourceId = sourceId
		self.targetType = targetType
		self.targetId = targetId
		self.createdBy = createdBy
		self.createdAt = createdAt
	}
}

/// Where an item came from: the session that produced it, who ran it, when, and the chat that
/// started the session. Read from the item's graph, as web's `resolveLineage` does.
public struct ObjectOrigin: Sendable, Equatable {
	public var sessionId: String
	/// The actor that ran the session; resolve it to a name, never show it.
	public var actorId: String?
	public var spawnedAt: Date?
	public var chatId: String?

	public init(sessionId: String, actorId: String? = nil, spawnedAt: Date? = nil, chatId: String? = nil) {
		self.sessionId = sessionId
		self.actorId = actorId
		self.spawnedAt = spawnedAt
		self.chatId = chatId
	}

	/// The oldest `produced_by` edge from a session into the item (origin is where it began, not
	/// who touched it last), plus the chat that spawned that session when the graph carries it.
	/// `nil` when no session produced the item: nothing shows then.
	public static func resolve(objectId: String, edges: [OriginEdge]) -> ObjectOrigin? {
		let produced = edges
			.filter { $0.type == "produced_by" && $0.sourceType == "session" && $0.targetId == objectId }
			.min { ($0.createdAt ?? .distantFuture) < ($1.createdAt ?? .distantFuture) }
		guard let produced else { return nil }
		let chat = edges.first { $0.type == "spawned" && $0.targetType == "session" && $0.targetId == produced.sourceId }
		return ObjectOrigin(
			sessionId: produced.sourceId, actorId: produced.createdBy, spawnedAt: produced.createdAt,
			chatId: chat?.sourceId)
	}
}

/// One entry of an object's activity stream, as the server records it.
public struct ObjectEvent: Identifiable, Sendable, Equatable {
	public var id: Int
	public var actorId: String?
	public var action: String
	public var data: JSONValue?
	public var createdAt: Date?
	/// Server-rendered sentence for non-comment events ("moved status from x to y").
	public var summary: String?

	public init(
		id: Int, actorId: String?, action: String, data: JSONValue? = nil, createdAt: Date? = nil,
		summary: String? = nil
	) {
		self.id = id
		self.actorId = actorId
		self.action = action
		self.data = data
		self.createdAt = createdAt
		self.summary = summary
	}
}

/// Everything `GET /api/objects/{id}/graph` returns that the detail screen shows.
public struct ObjectGraph: Sendable, Equatable {
	public var object: WorkObject
	public var links: [ObjectLink]
	public var events: [ObjectEvent]
	public var origin: ObjectOrigin?

	public init(object: WorkObject, links: [ObjectLink], events: [ObjectEvent], origin: ObjectOrigin? = nil) {
		self.object = object
		self.links = links
		self.events = events
		self.origin = origin
	}
}

/// A person or agent, enough to attribute and label.
public struct ActorRef: Identifiable, Sendable, Equatable {
	public var id: String
	public var name: String
	public var isAgent: Bool

	public init(id: String, name: String, isAgent: Bool) {
		self.id = id
		self.name = name
		self.isAgent = isAgent
	}
}

/// What the workspace has configured: which object types exist, their display names and the
/// ordered statuses each allows (workspace settings `statuses` / `display_names`).
public struct ObjectsSchema: Sendable, Equatable {
	public var types: [String]
	public var displayNames: [String: String]
	public var statuses: [String: [String]]

	public init(types: [String], displayNames: [String: String], statuses: [String: [String]]) {
		self.types = types
		self.displayNames = displayNames
		self.statuses = statuses
	}

	/// The defaults every workspace starts with (`workspaceSettingsSchema`), used until the real
	/// settings load and whenever they can't.
	public static let fallback = ObjectsSchema(
		types: ["insight", "bet", "task"],
		displayNames: ["insight": "Insight", "bet": "Bet", "task": "Task"],
		statuses: [
			"insight": ["new", "processing", "clustered", "scored", "parked", "discarded"],
			"bet": ["opportunity", "define", "active", "live", "succeeded", "failed", "paused", "archived"],
			"task": ["backlog", "todo", "in_progress", "in_review", "validated", "done", "discarded"],
		])

	public func displayName(for type: String) -> String {
		displayNames[type] ?? type.replacingOccurrences(of: "_", with: " ").capitalized
	}

	public func statuses(for type: String?) -> [String] {
		if let type, let list = statuses[type] { return list }
		var seen = Set<String>()
		return types.flatMap { statuses[$0] ?? [] }.filter { seen.insert($0).inserted }
	}
}

/// Server-side filters for the list.
public struct ObjectsQuery: Sendable, Equatable {
	public var type: String?
	public var status: String?
	/// Only objects this actor drives (an agent's page).
	public var driver: String?
	public var search: String
	public var limit: Int
	public var offset: Int
	public var sort: ObjectsSort
	/// Against the sort's natural direction (oldest first, Z to A).
	public var reversed: Bool

	public init(
		type: String? = nil, status: String? = nil, driver: String? = nil, search: String = "", limit: Int = 50,
		offset: Int = 0, sort: ObjectsSort = .needsYou,
		reversed: Bool = false
	) {
		self.reversed = reversed
		self.type = type
		self.status = status
		self.driver = driver
		self.search = search
		self.limit = limit
		self.offset = offset
		self.sort = sort
	}
}

/// Fields of a new object.
public struct ObjectDraft: Sendable, Equatable {
	public var type: String
	public var title: String
	public var content: String
	public var status: String

	public init(type: String, title: String = "", content: String = "", status: String) {
		self.type = type
		self.title = title
		self.content = content
		self.status = status
	}

	public var isValid: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

/// A partial update; `nil` leaves the field alone.
/// The chat and the agent a card edit was made for (`chat` on `PATCH /api/objects/{id}`).
public struct ObjectPatchChat: Sendable, Equatable {
	public var conversationID: String
	public var agentID: String

	public init(conversationID: String, agentID: String) {
		self.conversationID = conversationID
		self.agentID = agentID
	}
}

public struct ObjectPatch: Sendable, Equatable {
	public var title: String?
	public var content: String?
	public var status: String?
	/// The actor to drive the object (assign). Nil leaves the driver alone.
	public var driver: String?
	/// Shallow-merged into `metadata` (as the server does); an empty-string value removes that
	/// key. `nil` leaves metadata alone.
	public var metadata: [String: String]?
	/// The chat card the edit was made from: the server tells the agent behind it. Nil elsewhere.
	public var chat: ObjectPatchChat?

	public init(
		title: String? = nil, content: String? = nil, status: String? = nil, driver: String? = nil,
		metadata: [String: String]? = nil, chat: ObjectPatchChat? = nil
	) {
		self.title = title
		self.content = content
		self.status = status
		self.driver = driver
		self.metadata = metadata
		self.chat = chat
	}

	public func applied(to object: WorkObject) -> WorkObject {
		var copy = object
		if let title { copy.title = title }
		if let content { copy.content = content }
		if let status { copy.status = status }
		if let driver { copy.driverId = driver }
		if let metadata {
			for (key, value) in metadata {
				if value.isEmpty { copy.metadata.removeValue(forKey: key) } else { copy.metadata[key] = value }
			}
		}
		return copy
	}
}

public struct ObjectsError: Error, Equatable, Sendable {
	public var message: String
	/// The device has no connection, as opposed to the server refusing.
	public var isOffline: Bool

	public init(_ message: String, isOffline: Bool = false) {
		self.message = message
		self.isOffline = isOffline
	}
}
