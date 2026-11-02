import Foundation

/// Where a live voice conversation with an agent stands: you are speaking, the agent is working on
/// an answer, or the agent is speaking it.
public enum LiveVoicePhase: Sendable, Equatable {
	case listening, thinking, speaking
}
