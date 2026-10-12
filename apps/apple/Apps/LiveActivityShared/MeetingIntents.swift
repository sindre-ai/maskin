#if os(iOS)
	import AppIntents
	import MaskinCore

	/// "Mute" on the meeting card. Runs in the app process, where the call is.
	struct ToggleMeetingMuteIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "Mute"
		static let description = IntentDescription("Mutes or unmutes your microphone in the live meeting.")
		static let openAppWhenRun = false

		init() {}

		func perform() async throws -> some IntentResult {
			await MainActor.run { MeetingCallControl.shared.performToggleMute() }
			return .result()
		}
	}

	/// "End" on the meeting card: hangs up the call, not just the card.
	struct EndMeetingIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "End"
		static let description = IntentDescription("Ends the live meeting.")
		static let openAppWhenRun = false

		init() {}

		func perform() async throws -> some IntentResult {
			await MainActor.run { MeetingCallControl.shared.performHangUp() }
			return .result()
		}
	}
#endif
