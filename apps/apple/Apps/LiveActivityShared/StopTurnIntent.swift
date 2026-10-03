#if os(iOS)
	import ActivityKit
	import AppIntents
	import MaskinCore

	/// The Stop button on the Live Activity. Compiled into BOTH the app and the Live Activity
	/// extension: the extension needs the type to render `Button(intent:)`, and the system runs
	/// `perform()` in the APP process (that is what `LiveActivityIntent` means), so the app's
	/// Keychain session is the one used. The extension binary still contains the network and
	/// Keychain code this references (it links MaskinCore); it just never runs it.
	struct StopTurnIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "Stop agent"
		static let description = IntentDescription("Stops the agent turn that is running.")
		/// A Stop from the Lock Screen must not pull the user into the app.
		static let openAppWhenRun = false

		@Parameter(title: "Session") var sessionId: String
		@Parameter(title: "Workspace") var workspaceId: String

		init() {}

		init(sessionId: String, workspaceId: String) {
			self.sessionId = sessionId
			self.workspaceId = workspaceId
		}

		func perform() async throws -> some IntentResult {
			let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
			let baseURL = raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
			let stopped = await TurnStopper.production(
				baseURL: baseURL, clientSource: "ios", secrets: KeychainSecretStore()
			).stop(sessionId: sessionId, workspaceId: workspaceId)
			guard stopped else { return .result() }
			// Show it ended at once rather than waiting for the next poll or push.
			for activity in Activity<MaskinTurnAttributes>.activities
			where activity.attributes.sessionId == sessionId {
				var state = activity.content.state
				state.status = .failed
				state.step = "Stopped"
				await activity.end(
					ActivityContent(state: state, staleDate: nil),
					dismissalPolicy: .after(Date().addingTimeInterval(10)))
			}
			return .result()
		}
	}
#endif
