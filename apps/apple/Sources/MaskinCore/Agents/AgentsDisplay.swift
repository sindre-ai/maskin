import Foundation

/// How the Agents list is ordered (the Display sheet's "Sort by").
public enum AgentsSort: String, CaseIterable, Identifiable, Equatable, Sendable, Codable {
	/// Needs attention first, then working, then idle.
	case status
	case name
	/// Most sessions first.
	case sessions

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .status: "Status"
		case .name: "Name"
		case .sessions: "Sessions"
		}
	}
}

/// What the Agents list is grouped by (the Display sheet's "Group by").
public enum AgentsGrouping: String, CaseIterable, Identifiable, Equatable, Sendable, Codable {
	case team, status, none

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .team: "Team"
		case .status: "Status"
		case .none: "None"
		}
	}
}

/// The person's Display choices for the Agents list. The status and team chips above the list
/// write the same two filters the Display sheet does, so there is one state, not two.
public struct AgentsDisplay: Equatable, Sendable, Codable {
	public var sort: AgentsSort
	/// Flips the order of `sort`.
	public var reversed: Bool
	public var grouping: AgentsGrouping
	/// Nil shows every status.
	public var status: AgentStatus?
	/// A team's name (`AgentsStore.teams`), or nil for every team.
	public var team: String?
	/// Each row's team line. Always off while grouped by team: the header already says it.
	public var showsTeam: Bool
	/// Each row's latest activity line ("Running for 12 min", "Standing by").
	public var showsLatest: Bool

	public static let `default` = AgentsDisplay()

	public init(
		sort: AgentsSort = .status, reversed: Bool = false, grouping: AgentsGrouping = .team,
		status: AgentStatus? = nil, team: String? = nil, showsTeam: Bool = true,
		showsLatest: Bool = false
	) {
		self.sort = sort
		self.reversed = reversed
		self.grouping = grouping
		self.status = status
		self.team = team
		self.showsTeam = showsTeam
		self.showsLatest = showsLatest
	}

	/// Anything off its default, so a Display button can show it.
	public var isCustomized: Bool { self != .default }

	/// Whether a row carries its own team line.
	public var rowShowsTeam: Bool { showsTeam && grouping != .team }

	public mutating func reset() { self = .default }
}

/// One block of the Agents list. `title` is nil when the list is not grouped.
public struct AgentSection: Identifiable, Equatable, Sendable {
	public var id: String
	public var title: String?
	public var items: [AgentSummary]
}

/// A chip's label and how many agents it would show.
public struct AgentChipCount: Identifiable, Equatable, Sendable {
	public var id: String
	public var label: String
	public var count: Int
}

extension AgentStatus {
	/// The "Status" sort and group order: failed first (it needs you), then working, idle,
	/// disabled.
	var attentionRank: Int {
		switch self {
		case .failed: 0
		case .running: 1
		case .idle: 2
		case .paused: 3
		}
	}

	/// The group header when grouping by status.
	var groupTitle: String { self == .failed ? "Needs attention" : label }
}

/// Where an agent works: the flows that list it. The first one (A to Z) is its team.
public enum AgentTeams {
	public static let none = "No team"

	/// A flow's name as a team label: the part before a colon ("Product Delivery: bets to PRs").
	public static func name(of flow: LoopSummary) -> String {
		let full = flow.displayName
		let head = full.split(separator: ":", maxSplits: 1).first.map(String.init) ?? full
		let trimmed = head.trimmingCharacters(in: .whitespaces)
		return trimmed.isEmpty ? full : trimmed
	}
}

extension AgentSummary {
	/// The "latest" line under a row: what a working agent is doing, or why a quiet one is quiet.
	public func latestLine(now: Date = Date()) -> String {
		switch status {
		case .running:
			if let activity = latestSession?.currentActivity, !activity.isEmpty { return activity }
			if let seconds = latestSession?.duration(now: now) {
				return "Running for \(AgentDuration.words(seconds))"
			}
			return "Running now"
		case .failed: return "Last run failed"
		case .paused: return "Disabled"
		case .idle: return "Standing by"
		}
	}
}

/// "12 min", "2 h", "3 days": the spoken length of a run.
public enum AgentDuration {
	public static func words(_ seconds: TimeInterval) -> String {
		let total = max(0, Int(seconds))
		if total < 60 { return "under a minute" }
		if total < 3600 { return "\(total / 60) min" }
		if total < 86_400 { return "\(total / 3600) h" }
		let days = total / 86_400
		return days == 1 ? "1 day" : "\(days) days"
	}
}
