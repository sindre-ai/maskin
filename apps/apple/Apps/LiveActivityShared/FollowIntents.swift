#if os(iOS)
	import ActivityKit
	import AppIntents
	import MaskinCore

	/// "Stop following" on the follow Live Activity. Compiled into the app and the extension (the
	/// extension needs the type to render `Button(intent:)`); the system runs `perform()` in the app
	/// process, where the controller lives. It never opens the app.
	struct StopFollowingIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "Stop following"
		static let description = IntentDescription("Stops following an agent on the Lock Screen.")
		static let openAppWhenRun = false
		static let isDiscoverable = false

		@Parameter(title: "Session") var sessionId: String

		init() {}
		init(sessionId: String) { self.sessionId = sessionId }

		func perform() async throws -> some IntentResult {
			if let controller = await FollowActivityController.shared {
				await controller.stopFollowing(sessionId: sessionId)
			}
			// The controller is gone when the app was relaunched by this intent: end the card directly.
			for activity in Activity<MaskinFollowAttributes>.activities
			where activity.attributes.target.sessionId == sessionId {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
			return .result()
		}
	}
#endif
