import Foundation

/// The one line a live call shows for where it stands, in the banner, the control bar and the pill.
public enum LiveCallStatus {
	/// Failure and notices win over the phase; muted wins over listening. `interruptible` is for the
	/// dock, where tapping the avatar cuts the agent off.
	public static func text(
		phase: LiveVoicePhase, isMuted: Bool, failure: String?, notice: String?, leadName: String,
		hasWords: Bool, yourTurn: Bool = false, interruptible: Bool = false
	) -> String {
		if let failure { return failure }
		if let notice { return notice }
		if isMuted { return "Microphone off" }
		switch phase {
		case .listening: return hasWords ? "Hearing you…" : "Listening…"
		case .thinking: return "Working on it…"
		case .speaking:
			if yourTurn { return "Your turn…" }
			return interruptible ? "Speaking. Tap to interrupt" : "\(leadName) is speaking…"
		}
	}

	/// "LIVE · with Relay" for the banner, "LIVE BRIEFING · with Relay" for the daily briefing.
	public static func title(kind: LiveMeetingKind, leadName: String) -> String {
		(kind == .dailyBriefing ? "LIVE BRIEFING" : "LIVE") + " · with \(leadName)"
	}
}
