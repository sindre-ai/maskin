import Foundation

/// What the card for a linked loop shows. Read from the loops list when the loop is in it; otherwise
/// from the loop's own object record, which has a name, a description and a state but no counts.
public struct LinkedLoop: Equatable, Sendable {
	public var target: LinkedTarget
	/// Nil when the loop has no name.
	public var name: String?
	/// The description in plain words. Nil when there is none.
	public var summary: String?
	public var pill: LoopPill
	/// Nil when the loop is not in the loaded list: the Agents fact is then left out.
	public var agentCount: Int?
	/// "3 in progress · 12 closed". Nil when the loop is not in the loaded list.
	public var activity: String?
	public var firstAgentID: String?
	public var updatedAt: Date?

	public init(
		target: LinkedTarget, name: String?, summary: String? = nil, pill: LoopPill, agentCount: Int? = nil,
		activity: String? = nil, firstAgentID: String? = nil, updatedAt: Date? = nil
	) {
		self.target = target
		self.name = name
		self.summary = summary
		self.pill = pill
		self.agentCount = agentCount
		self.activity = activity
		self.firstAgentID = firstAgentID
		self.updatedAt = updatedAt
	}

	/// A loop read from the loops list: every fact is known.
	public init(target: LinkedTarget, summary loop: LoopSummary) {
		let name = loop.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		self.init(
			target: target, name: name.isEmpty ? nil : name, summary: LinkedObject.summary(from: loop.content),
			pill: loop.pill, agentCount: loop.agentIDs.count, activity: loop.statsLine,
			firstAgentID: loop.agentIDs.first, updatedAt: loop.updatedAt)
	}

	/// A loop read as an object: name, description and state, and no counts.
	public init(target: LinkedTarget, object: WorkObject) {
		let title = object.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		self.init(
			target: target, name: title.isEmpty ? nil : title, summary: LinkedObject.summary(from: object.content),
			pill: LoopPill(wire: object.status), updatedAt: object.updatedAt)
	}

	/// The name, or "Untitled flow" like the Flows list.
	public var displayName: String { name ?? "Untitled flow" }

	/// The badge: the loop's rung in words. "Waiting on you" where the Flows list says "Needs you".
	public var badge: String { Self.badge(for: pill) }

	public static func badge(for pill: LoopPill) -> String {
		pill == .waitingOnYou ? "Waiting on you" : pill.label
	}

	/// "1 agent", "3 agents". Nil when the count is not known.
	public var agentsFact: String? {
		agentCount.map { $0 == 1 ? "1 agent" : "\($0) agents" }
	}
}

/// What the card for a linked trigger shows, read from the triggers list.
public struct LinkedTrigger: Equatable, Sendable {
	public var target: LinkedTarget
	public var name: String
	public var kind: Trigger.Kind
	/// When it fires, in words: "Runs every day at 9:00 AM". Never the raw schedule or the instruction.
	public var whenItFires: String
	public var isOn: Bool
	/// The agent it wakes.
	public var agentID: String

	public init(target: LinkedTarget, name: String, kind: Trigger.Kind, whenItFires: String, isOn: Bool, agentID: String) {
		self.target = target
		self.name = name
		self.kind = kind
		self.whenItFires = whenItFires
		self.isOn = isOn
		self.agentID = agentID
	}

	public init(target: LinkedTarget, trigger: Trigger) {
		self.init(
			target: target, name: trigger.name.trimmingCharacters(in: .whitespacesAndNewlines), kind: trigger.kind,
			whenItFires: trigger.summary, isOn: trigger.enabled, agentID: trigger.targetActorID)
	}

	public var displayName: String { name.isEmpty ? "Untitled trigger" : name }

	/// "On" or "Off".
	public var badge: String { isOn ? "On" : "Off" }
}
