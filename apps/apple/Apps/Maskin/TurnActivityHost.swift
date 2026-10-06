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
			if state.status == .needsYou {
				await activity.update(
					content,
					alertConfiguration: AlertConfiguration(
						title: "\(state.agentName) needs you", body: "\(state.step)", sound: .default))
			} else {
				await activity.update(content)
			}
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

	extension Data {
		fileprivate var pushTokenHex: String { map { String(format: "%02x", $0) }.joined() }
	}
#endif
