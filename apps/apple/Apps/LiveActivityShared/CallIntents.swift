#if os(iOS)
	import ActivityKit
	import AppIntents
	import MaskinCore

	/// Runs a card button on the live call. With no call behind the card (the app was relaunched, the
	/// call already ended) it does nothing to a call and takes the stale card down instead.
	@MainActor
	private func performOnCall(_ action: LiveCallAction) async {
		guard LiveCallControl.shared.perform(action) == .noLiveCall else { return }
		if let controller = CallActivityController.shared {
			await controller.endStaleCards()
		} else {
			for activity in Activity<LiveCallActivityAttributes>.activities {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
		}
	}

	/// "Mute" / "Unmute" on the call card. Compiled into the app and the extension; the system runs
	/// `perform()` in the app process, where the call is.
	struct ToggleCallMuteIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "Mute"
		static let description = IntentDescription("Mutes or unmutes your microphone on the live call.")
		static let openAppWhenRun = false

		init() {}

		func perform() async throws -> some IntentResult {
			await performOnCall(.toggleMute)
			return .result()
		}
	}

	/// "End" on the call card: hangs up the call, not just the card.
	struct EndCallIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "End"
		static let description = IntentDescription("Ends the live call.")
		static let openAppWhenRun = false

		init() {}

		func perform() async throws -> some IntentResult {
			await performOnCall(.hangUp)
			return .result()
		}
	}
#endif
