import Foundation

#if os(iOS) && canImport(ActivityKit)
	import ActivityKit
#endif

/// One agent doing time-bound work, as the "Agents working" Live Activity shows it. One row per
/// agent (actor), however many sessions it runs; `sessionId` is the session Pause acts on.
///
/// JSON shape is a CONTRACT with the backend push sender (`docs/live-activity.md`): every key
/// below is present except the optionals, dates are Swift's default `Date` coding (seconds since
/// 2001-01-01), so do NOT put a date strategy on a coder that touches this type.
public struct WorkingAgent: Codable, Hashable, Sendable, Identifiable {
	public static let maxNameLength = 40
	public static let maxDoingLength = 80

	/// The agent's actor id.
	public var id: String
	/// The running session behind the row.
	public var sessionId: String
	public var name: String
	/// What the agent is doing, one line, present participle: "rolling out Retry policy v2".
	public var doing: String
	public var startedAt: Date
	/// When the work is expected to end; nil when nothing can say (then the row shows elapsed time).
	public var expectedFinishAt: Date?
	/// Ranks above everything that only touches internal state.
	public var touchesCustomersOrProduction: Bool
	/// Where Open goes: the object being worked on, else the conversation, else the agent.
	public var objectId: String?
	public var conversationId: String?
	/// The conversation's title, when the work happens in a chat: what the card says it is about.
	public var topic: String?

	public init(
		id: String, sessionId: String, name: String, doing: String? = nil, startedAt: Date,
		expectedFinishAt: Date? = nil, touchesCustomersOrProduction: Bool = false,
		objectId: String? = nil, conversationId: String? = nil, topic: String? = nil
	) {
		self.id = id
		self.sessionId = sessionId
		self.name = Self.clamp(name, to: Self.maxNameLength, fallback: "Agent")
		self.doing = Self.clamp(doing ?? "", to: Self.maxDoingLength, fallback: "working")
		self.startedAt = startedAt
		self.expectedFinishAt = expectedFinishAt
		self.touchesCustomersOrProduction = touchesCustomersOrProduction
		self.objectId = objectId
		self.conversationId = conversationId
		self.topic = Self.clampTopic(topic)
	}

	public static let maxTopicLength = 60

	/// Blank titles are no topic; long ones are cut so a push stays inside APNs' 4 KB limit.
	static func clampTopic(_ text: String?) -> String? {
		guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
		else { return nil }
		return trimmed.count > maxTopicLength ? String(trimmed.prefix(maxTopicLength - 1)) + "\u{2026}" : trimmed
	}

	/// Up to two letters for the avatar tile, the same rule as `ActorIdentity.initials` in
	/// MaskinUI (which the Live Activity extension does not link).
	public var initials: String { Self.initials(for: name) }

	public static func initials(for name: String) -> String {
		let words = name.split(whereSeparator: \.isWhitespace).map {
			String($0.filter { $0.isLetter || $0.isNumber })
		}.filter { !$0.isEmpty }
		switch words.count {
		case 0: return "?"
		case 1: return String(words[0].prefix(2)).uppercased()
		default: return (String(words[0].prefix(1)) + String(words[1].prefix(1))).uppercased()
		}
	}

	/// "Forge is rolling out Retry policy v2". A step that arrives capitalised ("Reading files")
	/// is lowered so the sentence reads; an acronym or a proper noun at the front is kept.
	public var sentence: String { "\(name) is \(Self.lowered(doing))" }

	static func lowered(_ text: String) -> String {
		guard let first = text.first, first.isUppercase else { return text }
		let word = text.prefix { !$0.isWhitespace }
		// "API", "LinkedIn", "Retry policy" → keep; "Reading" → "reading".
		let restIsLower = word.dropFirst().allSatisfy { !$0.isUppercase }
		guard restIsLower, word.count > 1 else { return text }
		return first.lowercased() + text.dropFirst()
	}

	/// True when the work ends within `window` of `now` (an overdue finish still counts: the
	/// agent is in its last stretch, not gone).
	public func finishesSoon(now: Date, window: TimeInterval = AgentsActivityState.finishingSoonWindow)
		-> Bool
	{
		guard let expectedFinishAt else { return false }
		return expectedFinishAt.timeIntervalSince(now) <= window
	}

	/// Whole minutes until the expected finish, never below 1 while a finish is known.
	public func minutesLeft(now: Date) -> Int? {
		guard let expectedFinishAt else { return nil }
		return max(1, Int((expectedFinishAt.timeIntervalSince(now) / 60).rounded(.up)))
	}

	/// "4 min left" / "1 min left"; nil when no finish is known (the row shows elapsed time then).
	public func timeLeftText(now: Date) -> String? {
		minutesLeft(now: now).map { "\($0) min left" }
	}

	/// Where Open goes, built through `DeepLink` so it is always a link the router accepts.
	public func openURL(workspaceId: String) -> URL {
		if let objectId { return DeepLink.object(workspaceId: workspaceId, id: objectId).url }
		if let conversationId { return DeepLink.chat(workspaceId: workspaceId, id: conversationId).url }
		return DeepLink.agent(workspaceId: workspaceId, id: id).url
	}

	private static func clamp(_ text: String, to limit: Int, fallback: String) -> String {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return fallback }
		return trimmed.count > limit ? String(trimmed.prefix(limit - 1)) + "\u{2026}" : trimmed
	}
}

/// The Live Activity's changing part: every agent doing time-bound work in the workspace, ranked.
/// `count` and `finishingSoon` describe the WHOLE set; `agents` carries only the top
/// `maxEncodedAgents` rows so a push stays inside APNs' 4 KB payload limit.
public struct AgentsActivityState: Codable, Hashable, Sendable {
	/// Rows carried in the payload: 3 shown expanded plus a few spare for stacked avatars.
	public static let maxEncodedAgents = 6
	/// "Finishing soon" means within this much of now.
	public static let finishingSoonWindow: TimeInterval = 15 * 60

	public var count: Int
	public var finishingSoon: Int
	/// Ranked: soonest finish first, then customer/production impact, then the longest-running.
	public var agents: [WorkingAgent]

	/// Ranks the full set, counts it, and keeps the top rows.
	public init(agents: [WorkingAgent], now: Date) {
		let ranked = Self.ranked(agents, now: now)
		count = ranked.count
		finishingSoon = ranked.filter { $0.finishesSoon(now: now) }.count
		self.agents = Array(ranked.prefix(Self.maxEncodedAgents))
	}

	/// Decoding is tolerant: a payload without the totals is read as "what you see is all".
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		agents = try c.decodeIfPresent([WorkingAgent].self, forKey: .agents) ?? []
		count = try c.decodeIfPresent(Int.self, forKey: .count) ?? agents.count
		finishingSoon = try c.decodeIfPresent(Int.self, forKey: .finishingSoon) ?? 0
	}

	public static let empty = AgentsActivityState(agents: [], now: .distantPast)

	public var isEmpty: Bool { count == 0 }

	/// The rows the expanded card shows.
	public var top: [WorkingAgent] { Array(agents.prefix(3)) }

	/// Soonest finish first (unknown finishes last), then customer/production work, then the
	/// agent that has been at it longest; ids break the last ties so the order is stable.
	public static func ranked(_ agents: [WorkingAgent], now: Date) -> [WorkingAgent] {
		agents.sorted { a, b in
			switch (a.expectedFinishAt, b.expectedFinishAt) {
			case let (x?, y?) where x != y: return x < y
			case (.some, .none): return true
			case (.none, .some): return false
			default: break
			}
			if a.touchesCustomersOrProduction != b.touchesCustomersOrProduction {
				return a.touchesCustomersOrProduction
			}
			if a.startedAt != b.startedAt { return a.startedAt < b.startedAt }
			return a.id < b.id
		}
	}

	/// Minutes until the last of the finishing-soon agents is done, for "3 finish in 15 min".
	public func finishingSoonMinutes(now: Date) -> Int? {
		let soon = agents.filter { $0.finishesSoon(now: now) }.compactMap { $0.minutesLeft(now: now) }
		return soon.max()
	}

	/// The expanded headline. One agent: "Forge is rolling out Retry policy v2". More: "23 agents
	/// working" plus " · 3 finish in 15 min" when any finish is known. Empty: "Agents finished".
	public func headline(now: Date) -> String {
		switch count {
		case 0: return "Agents finished"
		case 1: return agents.first?.sentence ?? "1 agent working"
		default:
			var text = "\(count) agents working"
			if finishingSoon > 0, let minutes = finishingSoonMinutes(now: now) {
				text += " · \(finishingSoon) finish in \(minutes) min"
			}
			return text
		}
	}

	/// "Pause rollout"-style label for the single-agent card: "Pause" plus the first two words of
	/// what the agent is doing, so the button names the thing without wrapping.
	public var pauseLabel: String {
		guard count == 1, let agent = agents.first else { return "Pause all" }
		let words = WorkingAgent.lowered(agent.doing).split(separator: " ").prefix(2).joined(separator: " ")
		return words.isEmpty ? "Pause" : "Pause \(words)"
	}
}

/// The fixed identity of the one activity: the workspace it belongs to.
public struct AgentsActivityIdentity: Codable, Hashable, Sendable {
	public var workspaceId: String

	public init(workspaceId: String) { self.workspaceId = workspaceId }

	/// Stable per workspace; the coordinator's key, since ActivityKit assigns its own ids.
	public var activityID: String { "agents-working:\(workspaceId)" }

	/// "See all": the Agents screen.
	public var seeAllURL: URL { DeepLink.agents(workspaceId: workspaceId).url }
}

#if os(iOS) && canImport(ActivityKit)
	/// ActivityKit attributes. The Swift type name is part of the backend contract
	/// (`attributes-type: "MaskinAgentsAttributes"`), as is the property name below.
	public struct MaskinAgentsAttributes: ActivityAttributes {
		public typealias ContentState = AgentsActivityState

		public let workspaceId: String

		public init(workspaceId: String) { self.workspaceId = workspaceId }
		public init(_ identity: AgentsActivityIdentity) { self.init(workspaceId: identity.workspaceId) }

		public var identity: AgentsActivityIdentity { AgentsActivityIdentity(workspaceId: workspaceId) }
	}
#endif

/// One agent turn in an open conversation, as `ChatStore` sees it. Chat sessions stay `running`
/// between turns, so the workspace-wide session list cannot tell a thinking agent from an idle
/// one; the open thread can (`replyInFlight`), and feeds the coordinator through this type.
public struct LiveTurn: Equatable, Sendable {
	public enum Status: Equatable, Sendable {
		case running, needsYou, done, failed
		public var isTerminal: Bool { self == .done || self == .failed }
	}

	public var sessionId: String
	public var workspaceId: String
	public var conversationId: String
	public var actorId: String
	public var agentName: String
	public var step: String?
	public var startedAt: Date
	public var status: Status
	/// The conversation's title.
	public var topic: String?

	public init(
		sessionId: String, workspaceId: String, conversationId: String, actorId: String,
		agentName: String, step: String? = nil, startedAt: Date, status: Status, topic: String? = nil
	) {
		self.sessionId = sessionId
		self.workspaceId = workspaceId
		self.conversationId = conversationId
		self.actorId = actorId
		self.agentName = agentName
		self.step = step
		self.startedAt = startedAt
		self.status = status
		self.topic = topic
	}

	/// The row this turn contributes to the aggregate; nil unless the agent is working. A turn
	/// that needs the user is a decision, and decisions never appear in the island.
	public var workingAgent: WorkingAgent? {
		guard status == .running else { return nil }
		return WorkingAgent(
			id: actorId, sessionId: sessionId, name: agentName, doing: step, startedAt: startedAt,
			conversationId: conversationId, topic: topic)
	}

	/// A chat session that has not been touched for this long is idle, not working: the same
	/// rule `ChatStore.liveSessions` applies to its "working" rows.
	public static let staleAfter: TimeInterval = 20 * 60

	/// Maps a conversation's sessions to turns. Live, recently touched sessions run while a reply
	/// is owed; paused ones need you; a session that just ended (or went quiet) is mapped too so
	/// the aggregate drops it at once. Agent names come from `agentName`; an unresolved actor
	/// reads "Agent", never an id.
	public static func turns(
		from sessions: [ChatAgentSession], workspaceId: String, conversationId: String,
		agentName: (String) -> String?, topic: String? = nil, now: Date, replyInFlight: Bool = true,
		staleAfter: TimeInterval = LiveTurn.staleAfter
	) -> [LiveTurn] {
		sessions.compactMap { session in
			let status: Status
			switch session.status {
			case .pending, .starting, .running:
				let touched = session.updatedAt ?? session.startedAt ?? now
				let stale = now.timeIntervalSince(touched) > staleAfter
				status = replyInFlight && !stale ? .running : .done
			case .paused: status = .needsYou
			case .completed: status = .done
			case .failed, .timeout: status = .failed
			case .other: return nil
			}
			return LiveTurn(
				sessionId: session.id, workspaceId: workspaceId, conversationId: conversationId,
				actorId: session.actorID, agentName: agentName(session.actorID) ?? "Agent",
				step: session.currentActivity, startedAt: session.startedAt ?? now, status: status,
				topic: topic)
		}
	}
}
