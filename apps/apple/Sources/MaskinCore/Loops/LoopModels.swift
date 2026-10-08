import Foundation

/// A loop's stored lifecycle rung, plus the per-viewer "needs you" overlay the list shows
/// as one badge. Mirrors `loopPillSchema`.
public enum LoopPill: String, Sendable, Equatable, CaseIterable, Codable {
	case draft, paused, learning, supervised
	case fullyAutonomous = "fully_autonomous"
	case waitingOnYou = "waiting_on_you"

	public init(wire: String) { self = LoopPill(rawValue: wire) ?? .draft }

	public var label: String {
		switch self {
		case .draft: "Draft"
		case .paused: "Paused"
		case .learning: "Learning"
		case .supervised: "Supervised"
		case .fullyAutonomous: "Fully autonomous"
		case .waitingOnYou: "Needs you"
		}
	}

	/// A loop that is actually running work through its triggers.
	public var isLive: Bool {
		switch self {
		case .learning, .supervised, .fullyAutonomous, .waitingOnYou: true
		case .draft, .paused: false
		}
	}
}

/// One measurable target on a loop (`metadata.targets`): what it counts, where it stands, the goal.
/// The API carries no due date or unit, so neither is modelled.
public struct LoopTarget: Equatable, Sendable, Codable {
	public var label: String
	public var source: String?
	public var actual: Double
	public var target: Double
	public var ownerID: String?
	/// `strict` counts anything under target as behind; otherwise 90% still reads as on target.
	public var isStrict: Bool

	public init(
		label: String, source: String? = nil, actual: Double, target: Double, ownerID: String? = nil,
		isStrict: Bool = false
	) {
		self.label = label
		self.source = source
		self.actual = actual
		self.target = target
		self.ownerID = ownerID
		self.isStrict = isStrict
	}

	/// Share of the goal reached, 0...1 (for a bar).
	public var fraction: Double {
		guard target > 0 else { return actual > 0 ? 1 : 0 }
		return min(max(actual / target, 0), 1)
	}
}

/// One loop in the list: an installed pipeline of agents with its derived stats.
public struct LoopSummary: Identifiable, Equatable, Sendable, Codable {
	public var id: String
	public var name: String?
	public var content: String?
	/// Stored lifecycle status (never `waitingOnYou`).
	public var status: LoopPill
	/// Status combined with the viewer's unread signal.
	public var pill: LoopPill
	public var entryCondition: String?
	public var closeCondition: String?
	/// Team, business unit or part of the business this loop belongs to (`metadata.tags`).
	public var tags: [String]
	public var inProgressCount: Int
	public var closedCount: Int
	public var medianTimeToClose: TimeInterval?
	public var agentIDs: [String]
	public var triggerIDs: [String]
	public var waitingCount: Int
	public var createdAt: Date?
	public var updatedAt: Date?
	/// Nil (or empty) when the loop has no targets; optional so older cached snapshots still decode.
	public var targets: [LoopTarget]?

	public init(
		id: String, name: String?, content: String? = nil, status: LoopPill = .learning,
		pill: LoopPill? = nil, entryCondition: String? = nil, closeCondition: String? = nil,
		tags: [String] = [],
		inProgressCount: Int = 0, closedCount: Int = 0, medianTimeToClose: TimeInterval? = nil,
		agentIDs: [String] = [], triggerIDs: [String] = [], waitingCount: Int = 0,
		createdAt: Date? = nil, updatedAt: Date? = nil, targets: [LoopTarget]? = nil
	) {
		self.id = id
		self.name = name
		self.content = content
		self.targets = targets
		self.status = status
		self.pill = pill ?? status
		self.entryCondition = entryCondition
		self.closeCondition = closeCondition
		self.tags = tags
		self.inProgressCount = inProgressCount
		self.closedCount = closedCount
		self.medianTimeToClose = medianTimeToClose
		self.agentIDs = agentIDs
		self.triggerIDs = triggerIDs
		self.waitingCount = waitingCount
		self.createdAt = createdAt
		self.updatedAt = updatedAt
	}

	public var displayName: String {
		let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? "Untitled flow" : trimmed
	}

	public var isPaused: Bool { status == .paused }

	/// Share of the loop's work that has closed, 0...1: the progress ring on the watch and TV.
	public var ringProgress: Double {
		let total = inProgressCount + closedCount
		return total == 0 ? 0 : Double(closedCount) / Double(total)
	}

	/// "3 in progress · 12 closed"
	public var statsLine: String {
		"\(inProgressCount) in progress · \(closedCount) closed"
	}

	/// What a pause or resume sets: resuming goes back to the first live rung, like the web app.
	public var toggledStatus: LoopPill { isPaused ? .learning : .paused }

	/// A copy showing `status` locally (optimistic update), pill recomputed.
	func with(status: LoopPill) -> LoopSummary {
		var copy = self
		copy.status = status
		copy.pill = (status.isLive && waitingCount > 0) ? .waitingOnYou : status
		return copy
	}
}

/// One step of a loop's pipeline: a trigger and the agent it runs.
public struct LoopStep: Identifiable, Equatable, Sendable {
	public var id: String { triggerID }
	public var triggerID: String
	public var name: String?
	public var actionPrompt: String?
	public var triggerKind: Trigger.Kind
	public var triggerConfig: JSONValue
	public var agentName: String?
	public var agentID: String?
	public var handsOffName: String?
	public var escalatesToName: String?
	public var escalateAfter: TimeInterval?
	public var pendingCount: Int

	public init(
		triggerID: String, name: String?, actionPrompt: String? = nil,
		triggerKind: Trigger.Kind = .other, triggerConfig: JSONValue = .object([:]),
		agentName: String? = nil, agentID: String? = nil, handsOffName: String? = nil,
		escalatesToName: String? = nil, escalateAfter: TimeInterval? = nil, pendingCount: Int = 0
	) {
		self.triggerID = triggerID
		self.name = name
		self.actionPrompt = actionPrompt
		self.triggerKind = triggerKind
		self.triggerConfig = triggerConfig
		self.agentName = agentName
		self.agentID = agentID
		self.handsOffName = handsOffName
		self.escalatesToName = escalatesToName
		self.escalateAfter = escalateAfter
		self.pendingCount = pendingCount
	}

	public var displayName: String {
		let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? "Untitled step" : trimmed
	}

	/// "Runs every day at 9:00 AM" / "When bet changes from any to done".
	public var firesSummary: String {
		TriggerDescriber.describe(kind: triggerKind, config: triggerConfig)
	}
}

/// One entry in a loop's recent-activity feed (trigger fired, session started/finished…).
public struct LoopActivityEntry: Identifiable, Equatable, Sendable {
	public var id: String
	public var action: String
	public var entityType: String
	public var actorID: String?
	public var description: String?
	public var createdAt: Date?

	public init(
		id: String, action: String, entityType: String, actorID: String? = nil,
		description: String? = nil, createdAt: Date? = nil
	) {
		self.id = id
		self.action = action
		self.entityType = entityType
		self.actorID = actorID
		self.description = description
		self.createdAt = createdAt
	}

	/// Sentence for the feed: the server's description, else the action in plain words.
	public var title: String {
		if let description, !description.trimmingCharacters(in: .whitespaces).isEmpty {
			return description
		}
		switch action {
		case "trigger_fired": return "Trigger fired"
		case "session_created": return "Session started"
		case "session_running": return "Session running"
		case "session_completed": return "Session finished"
		case "session_failed": return "Session failed"
		case "session_timeout": return "Session timed out"
		case "session_paused": return "Session paused"
		default:
			let text = action.replacingOccurrences(of: "_", with: " ")
			return text.prefix(1).uppercased() + text.dropFirst()
		}
	}

	/// Status key for the badge colour.
	public var tone: Tone {
		switch action {
		case "session_failed", "session_timeout": .failure
		case "session_completed": .success
		case "session_running", "session_created", "trigger_fired": .active
		default: .neutral
		}
	}

	public enum Tone: Sendable { case success, failure, active, neutral }
}

/// A loop installed from the marketplace; used to flag loops with a newer version available.
public struct LoopInstall: Equatable, Sendable, Codable {
	public var objectID: String?
	public var hasUpdate: Bool
	public var availableVersion: String
	public var isForked: Bool

	public init(objectID: String?, hasUpdate: Bool, availableVersion: String, isForked: Bool) {
		self.objectID = objectID
		self.hasUpdate = hasUpdate
		self.availableVersion = availableVersion
		self.isForked = isForked
	}
}

/// An object that belongs to a loop (an `in_loop` edge from the loop), as the loop page shows it.
public struct LoopMember: Identifiable, Equatable, Sendable {
	public var id: String
	public var type: String
	public var title: String
	public var status: String

	public init(id: String, type: String, title: String, status: String) {
		self.id = id
		self.type = type
		self.title = title
		self.status = status
	}
}

/// Something an agent posted on the loop's timeline (a top-level comment on the loop object).
public struct LoopPost: Identifiable, Equatable, Sendable {
	public var id: Int
	public var actorID: String?
	public var text: String
	public var date: Date?
	public var replyCount: Int
	/// The post asks the viewer to choose; it also surfaces in For You.
	public var isDecision: Bool

	public init(
		id: Int, actorID: String?, text: String, date: Date? = nil, replyCount: Int = 0,
		isDecision: Bool = false
	) {
		self.id = id
		self.actorID = actorID
		self.text = text
		self.date = date
		self.replyCount = replyCount
		self.isDecision = isDecision
	}
}

/// A file the loop (or one of its objects) produced: the `attached` edge to a `files` row.
public struct LoopOutput: Identifiable, Equatable, Sendable {
	public var id: String
	public var name: String
	/// The object it is attached to, when that is a member rather than the loop itself.
	public var sourceTitle: String?
	/// From the file's row; the graph edge carries neither, so these are nil until it is looked up.
	public var mimeType: String?
	public var updatedAt: Date?

	public init(
		id: String, name: String, sourceTitle: String? = nil, mimeType: String? = nil,
		updatedAt: Date? = nil
	) {
		self.id = id
		self.name = name
		self.sourceTitle = sourceTitle
		self.mimeType = mimeType
		self.updatedAt = updatedAt
	}

	public var kind: FileContentKind { .classify(mimeType: mimeType ?? "", name: name) }
	public var isHTML: Bool { kind == .html }
}

/// What the loop page needs beyond the step spine: who is in the loop, what agents said, and what
/// was produced. Assembled from the loop's object graph; every piece is best effort.
public struct LoopOverview: Equatable, Sendable {
	public var members: [LoopMember]
	public var posts: [LoopPost]
	public var outputs: [LoopOutput]
	/// The workspace's configured statuses for the member type, in workflow order.
	public var statusOrder: [String]

	public static let empty = LoopOverview(members: [], posts: [], outputs: [], statusOrder: [])

	public init(
		members: [LoopMember], posts: [LoopPost], outputs: [LoopOutput], statusOrder: [String]
	) {
		self.members = members
		self.posts = posts
		self.outputs = outputs
		self.statusOrder = statusOrder
	}
}
