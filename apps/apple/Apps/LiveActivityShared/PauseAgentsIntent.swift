#if os(iOS)
	import ActivityKit
	import AppIntents
	import MaskinCore

	/// The Pause buttons on the "Agents working" Live Activity: one agent's session, or every
	/// agent's at once ("Pause all"). Compiled into BOTH the app and the Live Activity extension:
	/// the extension needs the type to render `Button(intent:)`, and the system runs `perform()`
	/// in the APP process (that is what `LiveActivityIntent` means), so the app's Keychain session
	/// is the one used. The extension binary still contains the network and Keychain code this
	/// references (it links MaskinCore); it just never runs it.
	struct PauseAgentsIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "Pause agents"
		static let description = IntentDescription("Pauses the agents that are working.")
		/// A Pause from the Lock Screen must not pull the user into the app.
		static let openAppWhenRun = false

		@Parameter(title: "Sessions") var sessionIds: [String]
		@Parameter(title: "Workspace") var workspaceId: String

		init() {}

		init(sessionIds: [String], workspaceId: String) {
			self.sessionIds = sessionIds
			self.workspaceId = workspaceId
		}

		func perform() async throws -> some IntentResult {
			let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
			let baseURL = raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
			let paused = await SessionPauser.production(
				baseURL: baseURL, clientSource: "ios", secrets: KeychainSecretStore()
			).pause(sessionIds: sessionIds, workspaceId: workspaceId)
			guard !paused.isEmpty else { return .result() }
			// Take the paused agents off the card at once rather than waiting for the next refresh.
			let gone = Set(paused)
			for activity in Activity<MaskinAgentsAttributes>.activities
			where activity.attributes.workspaceId == workspaceId {
				let shown = activity.content.state
				let remaining = shown.agents.filter { !gone.contains($0.sessionId) }
				var next = AgentsActivityState(agents: remaining, now: Date())
				// The rows are only the top of the set; keep the total honest until the next refresh.
				next.count = max(next.count, shown.count - (shown.agents.count - remaining.count))
				if next.isEmpty {
					await activity.end(
						ActivityContent(state: next, staleDate: nil),
						dismissalPolicy: .after(Date().addingTimeInterval(10)))
				} else {
					await activity.update(ActivityContent(state: next, staleDate: Date().addingTimeInterval(15 * 60)))
				}
			}
			return .result()
		}
	}
#endif
