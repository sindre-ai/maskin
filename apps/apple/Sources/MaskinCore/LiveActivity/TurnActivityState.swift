import Foundation

#if os(iOS) && canImport(ActivityKit)
	import ActivityKit
#endif

/// Where a running agent turn is, for the Lock Screen / Dynamic Island Live Activity.
public enum TurnActivityStatus: String, Codable, Sendable, Equatable {
	case running, needsYou, done, failed

	public var isTerminal: Bool { self == .done || self == .failed }
}

/// The Live Activity's changing part. JSON shape is a CONTRACT with the backend push sender
/// (`ApnsSender.sendLiveActivity`): all keys always present, `startedAt` encoded as Swift's
/// default `Date` (seconds since 2001-01-01), so do NOT set a date strategy on any coder that
/// handles it.
public struct TurnActivityState: Codable, Hashable, Sendable {
	public static let maxAgentNameLength = 40
	public static let maxStepLength = 80

	public var sessionId: String
	public var agentName: String
	public var step: String
	public var startedAt: Date
	public var status: TurnActivityStatus

	public init(
		sessionId: String, agentName: String, step: String? = nil, startedAt: Date,
		status: TurnActivityStatus
	) {
		self.sessionId = sessionId
		self.agentName = Self.clamp(agentName, to: Self.maxAgentNameLength, fallback: "Agent")
		self.step = Self.clamp(
			step ?? "", to: Self.maxStepLength, fallback: Self.defaultStep(for: status))
		self.startedAt = startedAt
		self.status = status
	}

	public static func defaultStep(for status: TurnActivityStatus) -> String {
		switch status {
		case .running: "Working"
		case .needsYou: "Needs you"
		case .done: "Done"
		case .failed: "Failed"
		}
	}

	private static func clamp(_ text: String, to limit: Int, fallback: String) -> String {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return fallback }
		return trimmed.count > limit ? String(trimmed.prefix(limit - 1)) + "\u{2026}" : trimmed
	}
}

/// The fixed identity of one activity (the Live Activity attributes).
public struct TurnActivityIdentity: Codable, Hashable, Sendable {
	public var sessionId: String
	public var workspaceId: String
	public var conversationId: String?

	public init(sessionId: String, workspaceId: String, conversationId: String?) {
		self.sessionId = sessionId
		self.workspaceId = workspaceId
		self.conversationId = conversationId
	}

	/// Where a tap goes: the thread, else the inbox. Built through `DeepLink` so it is always a
	/// link the router accepts.
	public var openURL: URL {
		if let conversationId { return DeepLink.chat(workspaceId: workspaceId, id: conversationId).url }
		return DeepLink.notifications(workspaceId: workspaceId).url
	}
}

#if os(iOS) && canImport(ActivityKit)
	/// ActivityKit attributes. The Swift type name is part of the backend contract
	/// (`attributes-type: "MaskinTurnAttributes"`), as are the property names below.
	public struct MaskinTurnAttributes: ActivityAttributes {
		public typealias ContentState = TurnActivityState

		public let sessionId: String
		public let workspaceId: String
		public let conversationId: String?

		public init(sessionId: String, workspaceId: String, conversationId: String?) {
			self.sessionId = sessionId
			self.workspaceId = workspaceId
			self.conversationId = conversationId
		}

		public init(_ identity: TurnActivityIdentity) {
			self.init(
				sessionId: identity.sessionId, workspaceId: identity.workspaceId,
				conversationId: identity.conversationId)
		}

		public var identity: TurnActivityIdentity {
			TurnActivityIdentity(
				sessionId: sessionId, workspaceId: workspaceId, conversationId: conversationId)
		}
	}
#endif

/// One agent turn as the app sees it (from the session list), before it becomes an activity.
public struct LiveTurn: Equatable, Sendable {
	public var identity: TurnActivityIdentity
	public var state: TurnActivityState
	public init(identity: TurnActivityIdentity, state: TurnActivityState) {
		self.identity = identity
		self.state = state
	}

	/// Maps a conversation's sessions to turns. Live sessions run; paused ones need you; a session
	/// that just ended is mapped too so the activity can end with its final state. Agent names
	/// come from `agentName`; an unresolved actor reads "Agent", never an id.
	public static func turns(
		from sessions: [ChatAgentSession], workspaceId: String, conversationId: String,
		agentName: (String) -> String?, now: Date
	) -> [LiveTurn] {
		sessions.compactMap { session in
			let status: TurnActivityStatus
			switch session.status {
			case .pending, .starting, .running: status = .running
			case .paused: status = .needsYou
			case .completed: status = .done
			case .failed, .timeout: status = .failed
			case .other: return nil
			}
			return LiveTurn(
				identity: TurnActivityIdentity(
					sessionId: session.id, workspaceId: workspaceId, conversationId: conversationId),
				state: TurnActivityState(
					sessionId: session.id, agentName: agentName(session.actorID) ?? "Agent",
					step: session.currentActivity, startedAt: session.startedAt ?? now, status: status))
		}
	}
}
