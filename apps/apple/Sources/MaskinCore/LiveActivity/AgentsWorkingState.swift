import Foundation

#if os(iOS) && canImport(ActivityKit)
	import ActivityKit
#endif

// The aggregate "Agents working" Live Activity (handoff 8-Objects). iOS shows one Live Activity per
// app in the island, so Maskin runs ONE whose content scales with how many agents are working,
// never one per agent. Pure values here so the ranking and wording test without a device.

/// One running agent's slice of work, as the activity needs it.
public struct WorkingAgent: Codable, Hashable, Sendable, Identifiable {
	public static let maxNameLength = 24
	public static let maxWhatLength = 60

	public var id: String
	/// "Forge".
	public var name: String
	/// What it is doing, without the name: "rolling out Retry policy v2".
	public var what: String
	/// Minutes until it finishes. Nil when unknown (ranks after every known ETA).
	public var etaMinutes: Int?
	/// Touches customers or production: breaks a tie in favour of showing it.
	public var sensitive: Bool
	/// The object to open for this agent, when it works on one.
	public var objectId: String?

	public init(
		id: String, name: String, what: String, etaMinutes: Int? = nil, sensitive: Bool = false,
		objectId: String? = nil
	) {
		self.id = id
		self.name = Self.clamp(name, to: Self.maxNameLength, fallback: "Agent")
		self.what = Self.clamp(what, to: Self.maxWhatLength, fallback: "working")
		self.etaMinutes = etaMinutes.map { max(0, $0) }
		self.sensitive = sensitive
		self.objectId = objectId
	}

	/// "Forge is rolling out Retry policy v2".
	public var sentence: String { "\(name) is \(what)" }

	/// "6 min", "1 h 5 min", or empty when unknown.
	public var etaLabel: String { AgentsWorkingState.duration(etaMinutes) }

	private static func clamp(_ text: String, to limit: Int, fallback: String) -> String {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return fallback }
		return trimmed.count > limit ? String(trimmed.prefix(limit - 1)) + "\u{2026}" : trimmed
	}
}

/// The activity's changing part: how many agents work, and the few closest to finishing.
public struct AgentsWorkingState: Codable, Hashable, Sendable {
	/// How many rows the expanded view shows when several agents work.
	public static let visibleRows = 3
	/// "3 finish in 15 min": the window for the headline's second half.
	public static let finishWindowMinutes = 15

	/// Total agents working (not just the visible rows).
	public var total: Int
	/// The rows to show, already ranked (at most `visibleRows`).
	public var rows: [WorkingAgent]
	/// How many of all agents finish within `finishWindowMinutes`.
	public var finishingSoon: Int

	public init(total: Int, rows: [WorkingAgent], finishingSoon: Int) {
		self.total = max(0, total)
		self.rows = Array(rows.prefix(Self.visibleRows))
		self.finishingSoon = max(0, finishingSoon)
	}

	public enum Layout: Equatable, Sendable {
		/// One agent: "Forge is rolling out Retry policy v2", a bar, Pause rollout and Open.
		case single
		/// Several: stacked avatars and a count compact; three rows expanded.
		case many
	}

	public var layout: Layout { total <= 1 ? .single : .many }

	/// Nothing working: the activity should end.
	public var isEmpty: Bool { total == 0 }

	/// Up to three stacked avatars in the compact view.
	public var compactAvatars: [WorkingAgent] { Array(rows.prefix(3)) }

	/// The compact count ("23"); nil for a single agent.
	public var compactCount: String? { layout == .many ? "\(total)" : nil }

	/// "23 agents working \u{00B7} 3 finish in 15 min", or just "23 agents working".
	public var headline: String {
		switch layout {
		case .single: return rows.first?.sentence ?? "1 agent working"
		case .many:
			let base = "\(total) agents working"
			guard finishingSoon > 0 else { return base }
			return "\(base) \u{00B7} \(finishingSoon) finish in \(Self.finishWindowMinutes) min"
		}
	}

	/// Ranks every working agent and builds the state: soonest finish first, then anything touching
	/// customers or production, then by name for a stable order.
	public static func make(from agents: [WorkingAgent]) -> AgentsWorkingState {
		let ranked = rank(agents)
		let soon = agents.filter { ($0.etaMinutes ?? Int.max) <= finishWindowMinutes }.count
		return AgentsWorkingState(total: agents.count, rows: ranked, finishingSoon: soon)
	}

	public static func rank(_ agents: [WorkingAgent]) -> [WorkingAgent] {
		agents.sorted { a, b in
			let (ea, eb) = (a.etaMinutes ?? Int.max, b.etaMinutes ?? Int.max)
			if ea != eb { return ea < eb }
			if a.sensitive != b.sensitive { return a.sensitive }
			return a.name.localizedStandardCompare(b.name) == .orderedAscending
		}
	}

	static func duration(_ minutes: Int?) -> String {
		guard let minutes else { return "" }
		if minutes < 60 { return "\(max(1, minutes)) min" }
		let (h, m) = (minutes / 60, minutes % 60)
		return m == 0 ? "\(h) h" : "\(h) h \(m) min"
	}
}

#if os(iOS) && canImport(ActivityKit)
	/// One activity for the whole workspace, never one per agent.
	public struct MaskinAgentsWorkingAttributes: ActivityAttributes {
		public typealias ContentState = AgentsWorkingState

		public let workspaceId: String

		public init(workspaceId: String) { self.workspaceId = workspaceId }

		/// Opens the inbox: there is no Agents deep link yet.
		public var openURL: URL { DeepLink.notifications(workspaceId: workspaceId).url }
	}
#endif
