import Foundation

/// What the call orb shows, derived from where the call stands. Pure, so the rule is tested without
/// a view.
public enum CallOrbState: Sendable, Equatable {
	/// The call is being set up, or the connection dropped and is coming back: slow breathing.
	case connecting
	/// Your turn: the orb follows your microphone.
	case listening
	/// The agent is working on an answer: slow breathing.
	case thinking
	/// The agent is speaking: the orb follows its voice.
	case speaking
	/// Your microphone is off and nothing else is going on: dimmed and still.
	case muted

	/// The agent's voice is heard whether or not you are muted, so speaking and thinking win over
	/// muted. Muted only shows while it would otherwise be your turn.
	public static func derive(phase: LiveVoicePhase, isMuted: Bool, isConnected: Bool) -> CallOrbState {
		guard isConnected else { return .connecting }
		switch phase {
		case .speaking: return .speaking
		case .thinking: return .thinking
		case .listening: return isMuted ? .muted : .listening
		}
	}

	public var accessibilityLabel: String {
		switch self {
		case .connecting: "Connecting"
		case .listening: "Listening"
		case .thinking: "Thinking"
		case .speaking: "Agent speaking"
		case .muted: "Muted"
		}
	}

	/// Whether the orb moves with a live level (and which one), as opposed to breathing or resting.
	public enum LevelSource: Sendable, Equatable { case none, microphone, agent }

	public var levelSource: LevelSource {
		switch self {
		case .listening: .microphone
		case .speaking: .agent
		case .connecting, .thinking, .muted: .none
		}
	}
}
