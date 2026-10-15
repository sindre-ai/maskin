#if os(iOS)
	import ActivityKit
	import AppIntents
	import MaskinCore

	/// "Later" on a flow cycle that ended needing the reader. The ask stays in For you and in the
	/// notification; this only ends the card. Compiled into the app and the extension, like
	/// `StopTurnIntent`; the system runs `perform()` in the app process.
	struct DismissCycleActivityIntent: LiveActivityIntent {
		static let title: LocalizedStringResource = "Later"
		static let description = IntentDescription("Dismisses the flow card until you are ready.")
		static let openAppWhenRun = false

		@Parameter(title: "Flow") var flowId: String

		init() {}
		init(flowId: String) { self.flowId = flowId }

		func perform() async throws -> some IntentResult {
			for activity in Activity<MaskinCycleAttributes>.activities
			where activity.attributes.flowId == flowId {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
			return .result()
		}
	}
#endif
