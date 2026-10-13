#if os(iOS)
	@preconcurrency import ActivityKit
	import Foundation
	import MaskinCore

	/// ActivityKit side of `TurnActivityCoordinator`: starts, updates and ends the
	/// `MaskinTurnAttributes` activity, and forwards the push tokens (push-to-start, and one per
	/// activity) so the coordinator can register them with the backend.
	///
	/// Also adopts activities the backend started by push while the app was not running.
	/// REQUIRES a real device to verify: the simulator does not deliver Live Activity pushes.
	@MainActor
	final class TurnActivityHost: TurnActivityHosting {
		private weak var coordinator: TurnActivityCoordinator?
		private var observing: Set<String> = []
		private var tasks: [Task<Void, Never>] = []

		func attach(_ coordinator: TurnActivityCoordinator) {
			self.coordinator = coordinator
			guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
			if #available(iOS 17.2, *) {
				tasks.append(
					Task { [weak self] in
						for await data in Activity<MaskinTurnAttributes>.pushToStartTokenUpdates {
							await self?.coordinator?.pushToStartTokenChanged(data.pushTokenHex)
						}
					})
			}
			// Activities started by a push-to-start arrive here, with no `request` call from us.
			tasks.append(
				Task { [weak self] in
					for await activity in Activity<MaskinTurnAttributes>.activityUpdates {
						self?.observe(activity)
					}
				})
			for activity in Activity<MaskinTurnAttributes>.activities { observe(activity) }
		}

		private func observe(_ activity: Activity<MaskinTurnAttributes>) {
			let sessionId = activity.attributes.sessionId
			guard observing.insert(activity.id).inserted else { return }
			tasks.append(
				Task { [weak self] in
					for await data in activity.pushTokenUpdates {
						await self?.coordinator?.updateTokenChanged(
							sessionId: sessionId, token: data.pushTokenHex)
					}
				})
			tasks.append(
				Task { [weak self] in
					for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
						await self?.coordinator?.activityEnded(sessionId: sessionId)
						return
					}
				})
		}

		private func activity(for sessionId: String) -> Activity<MaskinTurnAttributes>? {
			Activity<MaskinTurnAttributes>.activities.first { $0.attributes.sessionId == sessionId }
		}

		func activeSessionIds() -> Set<String> {
			Set(
				Activity<MaskinTurnAttributes>.activities.filter { $0.activityState == .active }
					.map(\.attributes.sessionId))
		}

		func start(_ identity: TurnActivityIdentity, state: TurnActivityState) async {
			guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
			let content = ActivityContent(
				state: state, staleDate: Date().addingTimeInterval(15 * 60))
			do {
				let activity = try Activity.request(
					attributes: MaskinTurnAttributes(identity), content: content, pushType: .token)
				observe(activity)
			} catch {
				// Denied, or too many activities: the turn simply has no card.
			}
		}

		func update(sessionId: String, state: TurnActivityState) async {
			guard let activity = activity(for: sessionId) else { return }
			let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(15 * 60))
			// No alert: a turn waiting on the reader is a notification, not a Live Activity.
			await activity.update(content)
		}

		func cards() -> [TurnActivityCard] {
			Activity<MaskinTurnAttributes>.activities.compactMap { activity in
				guard activity.activityState == .active || activity.activityState == .stale else { return nil }
				return TurnActivityCard(
					sessionId: activity.attributes.sessionId, workspaceId: activity.attributes.workspaceId,
					agentName: activity.content.state.agentName, startedAt: activity.content.state.startedAt,
					isStale: activity.activityState == .stale)
			}
		}

		func endNow(sessionId: String) async {
			for activity in Activity<MaskinTurnAttributes>.activities
			where activity.attributes.sessionId == sessionId {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
		}

		func refresh(sessionId: String) async {
			guard let activity = activity(for: sessionId) else { return }
			await activity.update(
				ActivityContent(
					state: activity.content.state, staleDate: Date().addingTimeInterval(15 * 60)))
		}

		func endAll() async {
			for activity in Activity<MaskinTurnAttributes>.activities {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
		}

		func end(sessionId: String, state: TurnActivityState, dismissAfter: TimeInterval) async {
			guard let activity = activity(for: sessionId) else { return }
			await activity.end(
				ActivityContent(state: state, staleDate: nil),
				dismissalPolicy: .after(Date().addingTimeInterval(dismissAfter)))
		}
	}

	/// Starts, updates and ends the flow-cycle activity. Nothing in the app calls this yet: the loop
	/// models carry no cycle number or progress to drive it (state comes from the cycle, never a timer).
	@MainActor
	final class CycleActivityHost {
		private func activity(flowId: String) -> Activity<MaskinCycleAttributes>? {
			Activity<MaskinCycleAttributes>.activities.first { $0.attributes.flowId == flowId }
		}

		func start(_ attributes: MaskinCycleAttributes, state: CycleActivityState) {
			guard ActivityAuthorizationInfo().areActivitiesEnabled, activity(flowId: attributes.flowId) == nil
			else { return }
			_ = try? Activity.request(
				attributes: attributes,
				content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(15 * 60)),
				pushType: nil)
		}

		/// A cycle that ended needing the reader stays up as "NEEDS YOU" until opened, or eight hours.
		func update(flowId: String, state: CycleActivityState) async {
			guard let activity = activity(flowId: flowId) else { return }
			let stale = state.phase == .needsYou
				? Date().addingTimeInterval(CycleActivityState.needsYouLifetime)
				: Date().addingTimeInterval(15 * 60)
			await activity.update(ActivityContent(state: state, staleDate: stale))
		}

		func end(flowId: String, state: CycleActivityState? = nil) async {
			guard let activity = activity(flowId: flowId) else { return }
			await activity.end(state.map { ActivityContent(state: $0, staleDate: nil) }, dismissalPolicy: .immediate)
		}
	}

	extension Data {
		fileprivate var pushTokenHex: String { map { String(format: "%02x", $0) }.joined() }
	}
#endif
