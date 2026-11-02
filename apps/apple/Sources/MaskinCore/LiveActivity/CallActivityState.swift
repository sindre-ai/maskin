import Foundation

/// A live voice call's changing part, as the Lock Screen and Dynamic Island draw it. The elapsed
/// time is `startedAt` rendered by the system (`Text(timerInterval:)`), so nothing updates per second.
public struct LiveCallActivityState: Codable, Hashable, Sendable {
	public enum Phase: String, Codable, Sendable, Equatable {
		case connecting, listening, speaking, thinking, muted, reconnecting

		/// The status line on the card.
		public var statusText: String {
			switch self {
			case .connecting: "Connecting…"
			case .listening: "Listening"
			case .speaking: "Speaking"
			case .thinking: "Thinking"
			case .muted: "Muted"
			case .reconnecting: "Reconnecting…"
			}
		}
	}

	public var phase: Phase
	/// Kept apart from `phase` so the button reads Unmute even while the card says Reconnecting.
	public var isMuted: Bool
	public var startedAt: Date

	public init(phase: Phase, isMuted: Bool, startedAt: Date) {
		self.phase = phase
		self.isMuted = isMuted
		self.startedAt = startedAt
	}

	public var statusText: String { phase.statusText }
}

/// Where the call's connection stands, as far as the app can tell.
public enum LiveCallConnection: Sendable, Equatable {
	case connecting, connected, reconnecting
}

/// What the card needs to know about the call right now.
public struct LiveCallSnapshot: Sendable, Equatable {
	public var voicePhase: LiveVoicePhase
	public var isMuted: Bool
	public var connection: LiveCallConnection
	/// The call failed or stopped: the card goes away.
	public var failed: Bool

	public init(
		voicePhase: LiveVoicePhase, isMuted: Bool, connection: LiveCallConnection = .connected,
		failed: Bool = false
	) {
		self.voicePhase = voicePhase
		self.isMuted = isMuted
		self.connection = connection
		self.failed = failed
	}

	/// A lost connection and a call still being set up beat everything (the microphone state is
	/// shown by the button); muted beats what the agent is doing, as in `LiveCallStatus`.
	public var activityPhase: LiveCallActivityState.Phase {
		switch connection {
		case .connecting: return .connecting
		case .reconnecting: return .reconnecting
		case .connected: break
		}
		if isMuted { return .muted }
		switch voicePhase {
		case .listening: return .listening
		case .thinking: return .thinking
		case .speaking: return .speaking
		}
	}

	public func state(startedAt: Date) -> LiveCallActivityState {
		LiveCallActivityState(phase: activityPhase, isMuted: isMuted, startedAt: startedAt)
	}
}

/// What a button on the card asks for.
public enum LiveCallAction: Sendable, Equatable {
	case toggleMute, hangUp
}

#if os(iOS) && canImport(ActivityKit)
	import ActivityKit

	public struct LiveCallActivityAttributes: ActivityAttributes {
		public typealias ContentState = LiveCallActivityState

		public let callId: String
		public let agentName: String
		public let workspaceId: String
		public let conversationId: String?

		public init(callId: String, agentName: String, workspaceId: String, conversationId: String?) {
			self.callId = callId
			self.agentName = agentName
			self.workspaceId = workspaceId
			self.conversationId = conversationId
		}

		public var openURL: URL {
			if let conversationId { return DeepLink.chat(workspaceId: workspaceId, id: conversationId).url }
			return DeepLink.notifications(workspaceId: workspaceId).url
		}
	}
#endif
