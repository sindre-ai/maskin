import Foundation
import MaskinCore

/// Design review: opens a call as soon as the shell appears, so the card can be screenshotted.
/// `MASKIN_DEMO_CALL=chief|briefing` picks the call (Chief of Staff chat, or the daily briefing);
/// `MASKIN_DEMO_CALL_STATE` is a comma list of `captions`, `collapsed`, `earpiece` applied to the card.
/// The simulator has no microphone, so the status line shows the voice loop's own failure text.
/// Compiled out of Release builds.
@MainActor
enum LiveCallDemo {
	static func startIfRequested(center: LiveCallCenter, environment: AppEnvironment) async {
		#if DEBUG
			let env = ProcessInfo.processInfo.environment
			guard let kind = env["MASKIN_DEMO_CALL"] else { return }
			center.present(kind == "briefing" ? .dailyBriefing : .chiefOfStaff, environment: environment)
			while center.current == nil, center.problem == nil { try? await Task.sleep(for: .milliseconds(200)) }
			let state = (env["MASKIN_DEMO_CALL_STATE"] ?? "").split(separator: ",").map(String.init)
			if state.contains("captions") { center.dock.toggleCaptions() }
			if state.contains("collapsed") { center.dock.toggleCollapsed() }
			if state.contains("earpiece") { center.toggleSpeaker() }
		#endif
	}
}
