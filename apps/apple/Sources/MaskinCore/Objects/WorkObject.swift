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

	public init(
		id: String, type: String, title: String? = nil, content: String? = nil, status: String,
		metadata: [String: String] = [:], driverId: String? = nil, createdBy: String? = nil,
		createdAt: Date? = nil, updatedAt: Date? = nil, isStarred: Bool = false,
		unreadCount: Int = 0, activeActivity: String? = nil
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
	}

	/// Never empty and never an id.
	public var displayTitle: String {
		let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? "Untitled" : trimmed
	}
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

	public init(
		id: String, relation: String, isOutgoing: Bool, otherId: String, otherType: String,
		otherTitle: String, otherStatus: String? = nil
	) {
		self.id = id
		self.relation = relation
		self.isOutgoing = isOutgoing
		self.otherId = otherId
		self.otherType = otherType
		self.otherTitle = otherTitle
		self.otherStatus = otherStatus
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

	public init(object: WorkObject, links: [ObjectLink], events: [ObjectEvent]) {
		self.object = object
		self.links = links
		self.events = events
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
			"bet": ["signal", "define", "active", "live", "succeeded", "failed", "paused", "archived"],
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
	public var search: String
	public var limit: Int
	public var offset: Int

	public init(type: String? = nil, status: String? = nil, search: String = "", limit: Int = 50, offset: Int = 0) {
		self.type = type
		self.status = status
		self.search = search
		self.limit = limit
		self.offset = offset
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
public struct ObjectPatch: Sendable, Equatable {
	public var title: String?
	public var content: String?
	public var status: String?

	public init(title: String? = nil, content: String? = nil, status: String? = nil) {
		self.title = title
		self.content = content
		self.status = status
	}

	func applied(to object: WorkObject) -> WorkObject {
		var copy = object
		if let title { copy.title = title }
		if let content { copy.content = content }
		if let status { copy.status = status }
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
