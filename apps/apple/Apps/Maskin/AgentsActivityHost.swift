#if os(iOS)
	@preconcurrency import ActivityKit
	import Foundation
	import MaskinCore

	/// ActivityKit side of `AgentsActivityCoordinator`: starts, updates and ends the one
	/// `MaskinAgentsAttributes` activity, and forwards the push tokens (push-to-start, and the
	/// activity's own update token) so the coordinator can register them with the backend.
	///
	/// Also adopts an activity the backend started by push while the app was not running, and
	/// collapses duplicates (a push-to-start racing a foreground start) down to one.
	/// REQUIRES a real device to verify: the simulator does not deliver Live Activity pushes.
	@MainActor
	final class AgentsActivityHost: AgentsActivityHosting {
		private weak var coordinator: AgentsActivityCoordinator?
		private var observing: Set<String> = []
		private var tasks: [Task<Void, Never>] = []

		func attach(_ coordinator: AgentsActivityCoordinator) {
			self.coordinator = coordinator
			guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
			if #available(iOS 17.2, *) {
				tasks.append(
					Task { [weak self] in
						for await data in Activity<MaskinAgentsAttributes>.pushToStartTokenUpdates {
							await self?.coordinator?.pushToStartTokenChanged(data.pushTokenHex)
						}
					})
			}
			// Activities started by a push-to-start arrive here, with no `request` call from us.
			tasks.append(
				Task { [weak self] in
					for await activity in Activity<MaskinAgentsAttributes>.activityUpdates {
						self?.observe(activity)
					}
				})
			for activity in Activity<MaskinAgentsAttributes>.activities { observe(activity) }
		}

		private func observe(_ activity: Activity<MaskinAgentsAttributes>) {
			guard observing.insert(activity.id).inserted else { return }
			tasks.append(
				Task { [weak self] in
					for await data in activity.pushTokenUpdates {
						// Only the activity on screen owns the device's update token.
						guard self?.current()?.id == activity.id else { continue }
						await self?.coordinator?.updateTokenChanged(data.pushTokenHex)
					}
				})
			tasks.append(
				Task { [weak self] in
					for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
						// Another live one (a duplicate we collapsed) means the card is still there.
						if self?.current() == nil { await self?.coordinator?.activityEnded() }
						return
					}
				})
		}

		/// The one live activity. Should two exist (push-to-start raced a local start), the older
		/// one stays and the newer is ended silently.
		private func current() -> Activity<MaskinAgentsAttributes>? {
			let live = Activity<MaskinAgentsAttributes>.activities.filter { $0.activityState == .active }
			guard let keep = live.min(by: { $0.id < $1.id }) else { return nil }
			for extra in live where extra.id != keep.id {
				Task { await extra.end(nil, dismissalPolicy: .immediate) }
			}
			return keep
		}

		func activeIdentity() -> AgentsActivityIdentity? { current()?.attributes.identity }

		func start(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async {
			guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
			if let existing = current() {
				// Already on screen (adopted or raced): bring it up to date instead of doubling.
				if existing.attributes.identity == identity {
					await existing.update(Self.content(state))
				} else {
					await existing.end(nil, dismissalPolicy: .immediate)
				}
				return
			}
			do {
				let activity = try Activity.request(
					attributes: MaskinAgentsAttributes(identity), content: Self.content(state), pushType: .token)
				observe(activity)
			} catch {
				// Denied, or too many activities: the agents simply have no card.
			}
		}

		func update(_ identity: AgentsActivityIdentity, state: AgentsActivityState) async {
			guard let activity = current(), activity.attributes.identity == identity else { return }
			await activity.update(Self.content(state))
		}

		func end(_ identity: AgentsActivityIdentity, state: AgentsActivityState, dismissAfter: TimeInterval) async {
			guard let activity = current(), activity.attributes.identity == identity else { return }
			await activity.end(
				ActivityContent(state: state, staleDate: nil),
				dismissalPolicy: .after(Date().addingTimeInterval(dismissAfter)))
		}

		func cards() -> [AgentsActivityCard] {
			Activity<MaskinAgentsAttributes>.activities
				.filter { $0.activityState == .active || $0.activityState == .stale }
				.map { AgentsActivityCard(id: $0.id, workspaceId: $0.attributes.workspaceId) }
		}

		func endNow(cardID: String) async {
			guard let activity = Activity<MaskinAgentsAttributes>.activities.first(where: { $0.id == cardID })
			else { return }
			await activity.end(nil, dismissalPolicy: .immediate)
		}

		func endAll() async {
			for activity in Activity<MaskinAgentsAttributes>.activities {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
		}

		/// If updates stop arriving (server down, app killed), the card reads stale after 15 min.
		private static func content(_ state: AgentsActivityState) -> ActivityContent<AgentsActivityState> {
			ActivityContent(state: state, staleDate: Date().addingTimeInterval(15 * 60))
		}
	}

	/// Starts, updates and ends the flow-cycle activity for flows the person follows (Notifications
	/// → Flows). Driven by `CycleActivityController` from the foreground flow list: state comes from
	/// the cycle, never a timer. Background updates need the push path main's API lacks.
	@MainActor
	final class CycleActivityHost: CycleActivityHosting {
		private func activity(flowId: String) -> Activity<MaskinCycleAttributes>? {
			Activity<MaskinCycleAttributes>.activities.first { $0.attributes.flowId == flowId }
		}

		func start(flowId: String, workspaceId: String, state: CycleActivityState) {
			guard ActivityAuthorizationInfo().areActivitiesEnabled, activity(flowId: flowId) == nil
			else { return }
			let attributes = MaskinCycleAttributes(flowId: flowId, workspaceId: workspaceId, objectId: flowId)
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

		func end(flowId: String) async {
			guard let activity = activity(flowId: flowId) else { return }
			await activity.end(nil, dismissalPolicy: .immediate)
		}
	}

	/// Starts, updates and ends the one live-meeting activity, driven by the meeting screen.
	@MainActor
	final class MeetingActivityHost: MeetingActivityHosting {
		private var activity: Activity<MaskinMeetingAttributes>? {
			Activity<MaskinMeetingAttributes>.activities.first
		}

		func start(meetingId: String, workspaceId: String, conversationId: String?, state: MeetingActivityState) {
			guard ActivityAuthorizationInfo().areActivitiesEnabled, activity == nil else { return }
			let attributes = MaskinMeetingAttributes(
				meetingId: meetingId, workspaceId: workspaceId, conversationId: conversationId)
			_ = try? Activity.request(
				attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
		}

		func update(state: MeetingActivityState) async {
			await activity?.update(ActivityContent(state: state, staleDate: nil))
		}

		func end() async {
			for live in Activity<MaskinMeetingAttributes>.activities {
				await live.end(nil, dismissalPolicy: .immediate)
			}
		}
	}

	extension Data {
		fileprivate var pushTokenHex: String { map { String(format: "%02x", $0) }.joined() }
	}
#endif
