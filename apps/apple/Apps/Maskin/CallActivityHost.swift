#if os(iOS)
	import ActivityKit
	import MaskinCore

	/// Starts, updates and ends the one live-call activity, driven by `CallActivityController`.
	@MainActor
	final class CallActivityHost: CallActivityHosting {
		private var watchers: [Task<Void, Never>] = []

		var areActivitiesEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

		func start(
			callId: String, agentName: String, workspaceId: String,
			conversationId: String?, state: LiveCallActivityState
		) {
			let attributes = LiveCallActivityAttributes(
				callId: callId, agentName: agentName,
				workspaceId: workspaceId, conversationId: conversationId)
			guard
				let activity = try? Activity.request(
					attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
			else { return }
			// One call at a time: anything else still up from before is stale.
			let keep = activity.id
			Task {
				for stale in Activity<LiveCallActivityAttributes>.activities where stale.id != keep {
					await stale.end(nil, dismissalPolicy: .immediate)
				}
			}
			// The system or the person ending the card while the call goes on keeps it gone.
			watchers.append(
				Task { [activity] in
					for await update in activity.activityStateUpdates {
						if update == .ended || update == .dismissed {
							CallActivityController.shared?.cardRemoved()
							return
						}
					}
				})
		}

		func update(state: LiveCallActivityState) async {
			for activity in Activity<LiveCallActivityAttributes>.activities {
				await activity.update(ActivityContent(state: state, staleDate: nil))
			}
		}

		func endAll() async {
			watchers.forEach { $0.cancel() }
			watchers = []
			for activity in Activity<LiveCallActivityAttributes>.activities {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
		}
	}
#endif
