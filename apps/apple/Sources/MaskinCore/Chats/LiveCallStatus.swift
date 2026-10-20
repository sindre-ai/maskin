import Foundation

/// The one line a live call shows for where it stands, in the banner, the control bar and the pill.
public enum LiveCallStatus {
	/// Failure and notices win over the phase; muted wins over listening.
	public static func text(
		phase: LiveVoicePhase, isMuted: Bool, failure: String?, notice: String?, leadName: String,
		hasWords: Bool, yourTurn: Bool = false
	) -> String {
		if let failure { return failure }
		if let notice { return notice }
		if isMuted { return "Muted" }
		switch phase {
		case .listening: return hasWords ? "Hearing you…" : "Listening…"
		case .thinking: return "\(leadName) is thinking…"
		case .speaking: return yourTurn ? "Your turn…" : "\(leadName) is speaking…"
		}
	}

	/// "LIVE · with Relay" for the banner, "LIVE BRIEFING · with Relay" for the daily briefing.
	public static func title(kind: LiveMeetingKind, leadName: String) -> String {
		(kind == .dailyBriefing ? "LIVE BRIEFING" : "LIVE") + " · with \(leadName)"
	}
}
