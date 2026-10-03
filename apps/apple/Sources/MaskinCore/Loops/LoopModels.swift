import Foundation

/// A loop's stored lifecycle rung, plus the per-viewer "waiting on you" overlay the list shows
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
		case .waitingOnYou: "Waiting on you"
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
	public var inProgressCount: Int
	public var closedCount: Int
	public var medianTimeToClose: TimeInterval?
	public var agentIDs: [String]
	public var triggerIDs: [String]
	public var waitingCount: Int
	public var createdAt: Date?
	public var updatedAt: Date?

	public init(
		id: String, name: String?, content: String? = nil, status: LoopPill = .learning,
		pill: LoopPill? = nil, entryCondition: String? = nil, closeCondition: String? = nil,
		inProgressCount: Int = 0, closedCount: Int = 0, medianTimeToClose: TimeInterval? = nil,
		agentIDs: [String] = [], triggerIDs: [String] = [], waitingCount: Int = 0,
		createdAt: Date? = nil, updatedAt: Date? = nil
	) {
		self.id = id
		self.name = name
		self.content = content
		self.status = status
		self.pill = pill ?? status
		self.entryCondition = entryCondition
		self.closeCondition = closeCondition
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
		return trimmed.isEmpty ? "Untitled loop" : trimmed
	}

	public var isPaused: Bool { status == .paused }

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
