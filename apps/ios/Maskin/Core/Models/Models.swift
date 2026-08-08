import Foundation

/// Wire types mirroring `apps/dev/src/lib/openapi-schemas.ts` and
/// `packages/shared/src/schemas/*`. Decoded with `.convertFromSnakeCase` (see
/// `APIClient`), which correctly handles this backend's mixed casing — some response
/// fields are camelCase (`workspaceId`), others snake_case (`unread_count`) in the same
/// object — because the strategy only rewrites keys that actually contain underscores.

/// A generic JSON value for `metadata`/`data` fields whose shape varies by object type.
enum JSONValue: Codable {
	case string(String)
	case number(Double)
	case bool(Bool)
	case object([String: JSONValue])
	case array([JSONValue])
	case null

	init(from decoder: Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let bool = try? container.decode(Bool.self) {
			self = .bool(bool)
		} else if let number = try? container.decode(Double.self) {
			self = .number(number)
		} else if let string = try? container.decode(String.self) {
			self = .string(string)
		} else if let array = try? container.decode([JSONValue].self) {
			self = .array(array)
		} else if let object = try? container.decode([String: JSONValue].self) {
			self = .object(object)
		} else {
			self = .null
		}
	}

	func encode(to encoder: Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .string(let v): try container.encode(v)
		case .number(let v): try container.encode(v)
		case .bool(let v): try container.encode(v)
		case .object(let v): try container.encode(v)
		case .array(let v): try container.encode(v)
		case .null: try container.encodeNil()
		}
	}

	var stringValue: String? {
		if case .string(let v) = self { return v }
		return nil
	}

	subscript(key: String) -> JSONValue? {
		if case .object(let dict) = self { return dict[key] }
		return nil
	}
}

// MARK: - Actor

struct Actor: Codable, Identifiable, Hashable {
	let id: String
	let type: String
	let name: String
	let email: String?

	var isAgent: Bool { type == "agent" }
}

struct ActorWithKey: Codable {
	let id: String
	let type: String
	let name: String
	let email: String?
	let apiKey: String
	let workspaceId: String?
}

// MARK: - Object (insight | bet | task | loop)

struct MaskinObject: Codable, Identifiable, Hashable {
	let id: String
	let workspaceId: String
	let type: String
	let title: String?
	let content: String?
	let status: String
	let metadata: JSONValue?
	let driver: String?
	let createdBy: String
	let createdAt: String?
	let updatedAt: String?
	let isSubscribed: Bool?
	let unreadCount: Int?

	static func == (lhs: MaskinObject, rhs: MaskinObject) -> Bool { lhs.id == rhs.id }
	func hash(into hasher: inout Hasher) { hasher.combine(id) }

	/// `metadata.decision_type` — see `foryou-card-kind.ts`'s `hasDecisionType`.
	var decisionType: String? { metadata?["decision_type"]?.stringValue }
}

// MARK: - Comments (events with action == "commented")

struct CommentEvent: Codable, Identifiable, Hashable {
	struct Data: Codable, Hashable {
		let content: String?
		let mentions: [String]?
		let parentEventId: Int?
		let attachmentFileIds: [String]?
	}

	let id: Int
	let workspaceId: String
	let actorId: String
	let action: String
	let entityType: String
	let entityId: String
	let data: Data
	let createdAt: String?

	static func == (lhs: CommentEvent, rhs: CommentEvent) -> Bool { lhs.id == rhs.id }
	func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - Unread / Chats / For You

struct UnreadItem: Codable, Identifiable, Hashable {
	let entityType: String
	let entityId: String
	let unreadCount: Int
	let mentioningUnreadCount: Int
	let latestEventId: Int?
	let latestActivityAt: String?
	let object: MaskinObject?

	var id: String { entityId }

	static func == (lhs: UnreadItem, rhs: UnreadItem) -> Bool { lhs.entityId == rhs.entityId }
	func hash(into hasher: inout Hasher) { hasher.combine(entityId) }
}

struct UnreadResponse: Codable {
	let items: [UnreadItem]
}

// MARK: - Loops

struct LoopSummary: Codable, Identifiable, Hashable {
	let id: String
	let workspaceId: String
	let name: String?
	let guarantee: String?
	let status: String
	let pill: String // running | waiting_on_you | paused | archived
	let entryCondition: String?
	let closeCondition: String?
	let humanDecisionPoints: Int?
	let inProgressCount: Int
	let closedCount: Int
	let medianTimeToCloseMs: Int?
	let agentIds: [String]
	let triggerIds: [String]
	let waitingOnViewer: Bool
	let createdAt: String?

	static func == (lhs: LoopSummary, rhs: LoopSummary) -> Bool { lhs.id == rhs.id }
	func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
