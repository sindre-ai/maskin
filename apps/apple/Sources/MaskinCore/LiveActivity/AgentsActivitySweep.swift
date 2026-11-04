import Foundation

/// One agents Live Activity as the device sees it, stripped of ActivityKit types so the sweep
/// decision is a pure function.
public struct AgentsActivityCard: Equatable, Sendable {
	/// ActivityKit's own id for the activity.
	public var id: String
	public var workspaceId: String

	public init(id: String, workspaceId: String) {
		self.id = id
		self.workspaceId = workspaceId
	}
}

public enum AgentsSweepReason: String, Equatable, Sendable {
	/// The card belongs to another workspace than the signed-in one (or nobody is signed in).
	case otherWorkspace
	/// The workspace's agents are known and none is working: the card is orphaned.
	case nothingWorking
	/// A second card for the same workspace; only one may exist.
	case duplicate
}

public struct AgentsSweepPlan: Equatable, Sendable {
	public struct End: Equatable, Sendable {
		public var cardID: String
		public var reason: AgentsSweepReason
		public init(cardID: String, reason: AgentsSweepReason) {
			self.cardID = cardID
			self.reason = reason
		}
	}

	public var ends: [End]
	public init(ends: [End] = []) { self.ends = ends }
}

/// Decides which cards are dead weight. A card started by a backend push-to-start is only ended
/// by a backend `end` push, which is lost whenever the app never saw that activity's update token
/// (app not running, offline, token churn). This is the app-side backstop, run at launch and on
/// foreground once the workspace's running sessions are known.
public enum AgentsActivitySweep {
	/// `feedLoaded` is false until the workspace's session list has arrived at least once: until
	/// then an empty set means "unknown", never "nothing working", so a live card is left alone.
	public static func plan(
		cards: [AgentsActivityCard], workspaceId: String?, feedLoaded: Bool, hasWorkingAgents: Bool
	) -> AgentsSweepPlan {
		var plan = AgentsSweepPlan()
		var mine: [AgentsActivityCard] = []
		for card in cards.sorted(by: { $0.id < $1.id }) {
			if card.workspaceId != workspaceId {
				plan.ends.append(.init(cardID: card.id, reason: .otherWorkspace))
			} else {
				mine.append(card)
			}
		}
		if feedLoaded, !hasWorkingAgents {
			plan.ends += mine.map { .init(cardID: $0.id, reason: .nothingWorking) }
			return plan
		}
		// Same rule as the host's `current()`: the lowest id stays.
		plan.ends += mine.dropFirst().map { .init(cardID: $0.id, reason: .duplicate) }
		return plan
	}
}
