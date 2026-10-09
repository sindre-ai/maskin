import Foundation

/// A rule that fires an agent: on a schedule (cron), on a workspace event, or once (reminder).
public struct Trigger: Identifiable, Equatable, Sendable, Codable {
	public enum Kind: String, Sendable, Equatable, Codable {
		case cron, event, reminder, other

		public init(wire: String) { self = Kind(rawValue: wire) ?? .other }

		public var label: String {
			switch self {
			case .cron: "Schedule"
			case .event: "Event"
			case .reminder: "Reminder"
			case .other: "Trigger"
			}
		}

		public var symbol: String {
			switch self {
			case .cron: "clock"
			case .event: "bolt"
			case .reminder: "bell"
			case .other: "bolt"
			}
		}
	}

	public var id: String
	public var name: String
	public var kind: Kind
	public var config: JSONValue
	public var actionPrompt: String
	public var targetActorID: String
	public var enabled: Bool
	public var createdAt: Date?
	public var updatedAt: Date?

	public init(
		id: String, name: String, kind: Kind, config: JSONValue = .object([:]),
		actionPrompt: String = "", targetActorID: String = "", enabled: Bool = true,
		createdAt: Date? = nil, updatedAt: Date? = nil
	) {
		self.id = id
		self.name = name
		self.kind = kind
		self.config = config
		self.actionPrompt = actionPrompt
		self.targetActorID = targetActorID
		self.enabled = enabled
		self.createdAt = createdAt
		self.updatedAt = updatedAt
	}

	/// "Runs every day at 9:00 AM" / "When bet changes from any to done".
	public var summary: String { TriggerDescriber.describe(kind: kind, config: config) }

	/// The editable schedule of a cron trigger; `nil` for other kinds or an expression outside the
	/// shapes the app models (those stay read-only so a save never rewrites them).
	public var schedule: CronSchedule? {
		guard kind == .cron, let expression = config["expression"]?.stringValue else { return nil }
		return CronSchedule(expression: expression)
	}

	public var cronExpression: String? {
		kind == .cron ? config["expression"]?.stringValue : nil
	}
}

/// Human-readable trigger summaries — a port of `describeTrigger` in the web app.
public enum TriggerDescriber {
	public static func describe(kind: Trigger.Kind, config: JSONValue) -> String {
		switch kind {
		case .event:
			let entity = config["entity_type"]?.stringValue ?? "object"
			let action = config["action"]?.stringValue ?? "modified"
			if action == "status_changed" {
				let (from, to) = statusTransition(config)
				return "When \(entity) changes from \(from == anyStatus ? "any" : readable(from)) to \(to == anyStatus ? "any" : readable(to))"
			}
			return "When \(entity) is \(readable(action))"
		case .cron:
			if let expression = config["expression"]?.stringValue, !expression.isEmpty {
				return "Runs \(CronSchedule.describe(expression))"
			}
			return "Runs on a schedule"
		case .reminder:
			if let at = AutomationDates.parse(config["scheduled_at"]?.stringValue) {
				let style = Date.FormatStyle(date: .abbreviated, time: .shortened)
				return "Fires on \(at.formatted(style))"
			}
			return "One-time reminder"
		case .other:
			return "Custom trigger"
		}
	}

	static let anyStatus = "__any__"

	/// `from_status` / `to_status`, falling back to a `filter.status` value like the web form.
	static func statusTransition(_ config: JSONValue) -> (from: String, to: String) {
		let from = config["from_status"]?.stringValue ?? anyStatus
		if let to = config["to_status"]?.stringValue { return (from, to) }
		if let status = config["filter"]?["status"] {
			if let s = status.stringValue { return (from, s) }
			if case .array(let items) = status {
				let names = items.compactMap(\.stringValue)
				if !names.isEmpty, names.count == items.count { return (from, names.joined(separator: " or ")) }
			}
		}
		return (from, anyStatus)
	}

	private static func readable(_ value: String) -> String {
		value.replacingOccurrences(of: "_", with: " ")
	}
}

/// What starts a new trigger: a schedule, or something that happens in the workspace.
public enum TriggerWhenKind: String, CaseIterable, Identifiable, Equatable, Sendable {
	case schedule, event

	public var id: String { rawValue }
	public var label: String { self == .schedule ? "Schedule" : "Event" }
}

/// A workspace event a trigger can listen for, named in plain words. The wire form is the
/// `entity_type` + `action` pair the server matches on.
public struct TriggerEventRule: Equatable, Hashable, Identifiable, Sendable {
	public var entityType: String
	public var action: String

	public init(entityType: String, action: String) {
		self.entityType = entityType
		self.action = action
	}

	public var id: String { "\(entityType).\(action)" }

	/// "Task created", "Bet status changed".
	public var plainName: String {
		let noun = entityType.prefix(1).uppercased() + entityType.dropFirst()
		return "\(noun) \(action.replacingOccurrences(of: "_", with: " "))"
	}

	/// The events the app offers: the three built-in object types and what can happen to them.
	/// Workspace-defined object types are set up on the web.
	public static let options: [TriggerEventRule] = ["insight", "bet", "task"].flatMap { type in
		["created", "updated", "status_changed"].map { TriggerEventRule(entityType: type, action: $0) }
	}
}

/// Fields for creating a trigger: When (a schedule or an event) and Then (an agent and what it
/// should do). Reminders are created on the web.
public struct TriggerDraft: Equatable, Sendable {
	public var name = ""
	public var actionPrompt = ""
	public var targetActorID: String?
	public var whenKind: TriggerWhenKind = .schedule
	public var schedule = CronSchedule()
	public var event: TriggerEventRule?

	public init() {}

	public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
	public var trimmedPrompt: String { actionPrompt.trimmingCharacters(in: .whitespacesAndNewlines) }

	/// When is set: a schedule always is; an event only once one is picked.
	public var hasWhen: Bool { whenKind == .schedule || event != nil }
	/// Then is set: an agent and something for it to do.
	public var hasThen: Bool { targetActorID != nil && !trimmedPrompt.isEmpty }

	public var isValid: Bool { hasWhen && hasThen }

	/// The name sent to the server: what the person typed, else the When in words.
	public var resolvedName: String {
		if !trimmedName.isEmpty { return trimmedName }
		switch whenKind {
		case .schedule: return schedule.summary.prefix(1).uppercased() + schedule.summary.dropFirst()
		case .event: return event?.plainName ?? "Event trigger"
		}
	}

	/// A stable fingerprint of the When, so a retried create reuses its idempotency key.
	public var whenFingerprint: String {
		switch whenKind {
		case .schedule: return "cron:\(schedule.expression)"
		case .event: return "event:\(event?.id ?? "-")"
		}
	}
}

/// One past run of a trigger, from the session it started.
public struct TriggerRun: Identifiable, Equatable, Sendable {
	public enum Outcome: Equatable, Sendable { case ok, failed, running }

	public var id: String
	public var outcome: Outcome
	public var at: Date?

	public init(id: String, outcome: Outcome, at: Date? = nil) {
		self.id = id
		self.outcome = outcome
		self.at = at
	}

	/// Maps a session status to what the detail shows as a tick, a cross or a dot.
	public static func outcome(forStatus status: String) -> Outcome {
		switch status {
		case "completed": .ok
		case "failed", "timeout": .failed
		default: .running
		}
	}
}

/// What changed on an existing trigger. `nil` fields are left alone on the server.
public struct TriggerPatch: Equatable, Sendable {
	public var name: String?
	public var actionPrompt: String?
	public var targetActorID: String?
	public var enabled: Bool?
	/// A full replacement config; only ever set together with the trigger's own type.
	public var config: JSONValue?
	public var kind: Trigger.Kind?

	public init(
		name: String? = nil, actionPrompt: String? = nil, targetActorID: String? = nil,
		enabled: Bool? = nil, config: JSONValue? = nil, kind: Trigger.Kind? = nil
	) {
		self.name = name
		self.actionPrompt = actionPrompt
		self.targetActorID = targetActorID
		self.enabled = enabled
		self.config = config
		self.kind = kind
	}

	public var isEmpty: Bool {
		name == nil && actionPrompt == nil && targetActorID == nil && enabled == nil && config == nil
	}
}

/// The editable copy of a trigger on the detail screen.
public struct TriggerEdit: Equatable, Sendable {
	public var name: String
	public var actionPrompt: String
	public var targetActorID: String
	/// `nil` unless the trigger is a cron trigger with an expression the app can edit.
	public var schedule: CronSchedule?

	public init(_ trigger: Trigger) {
		name = trigger.name
		actionPrompt = trigger.actionPrompt
		targetActorID = trigger.targetActorID
		schedule = trigger.schedule
	}

	public var isValid: Bool {
		!name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& !actionPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& !targetActorID.isEmpty
	}

	/// The minimal patch that turns `trigger` into this edit; empty when nothing changed.
	public func patch(from trigger: Trigger) -> TriggerPatch {
		var patch = TriggerPatch()
		let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmedName != trigger.name { patch.name = trimmedName }
		let trimmedPrompt = actionPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmedPrompt != trigger.actionPrompt { patch.actionPrompt = trimmedPrompt }
		if targetActorID != trigger.targetActorID { patch.targetActorID = targetActorID }
		if let schedule, schedule != trigger.schedule, case .object(var config) = trigger.config {
			// Keep the rest of the cron config (a `scope` filter) when only the schedule moves.
			config["expression"] = .string(schedule.expression)
			patch.config = .object(config)
			patch.kind = .cron
		}
		return patch
	}
}
