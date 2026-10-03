import Foundation

#if canImport(ActivityKit) && os(iOS)
	import ActivityKit
#endif

/// Where a running agent session is, as a Live Activity / Dynamic Island shows it. Plain Codable
/// types live outside the ActivityKit guard so they build and test on every platform.
public enum SessionActivityPhase: String, Codable, Hashable, Sendable {
	case running, needsYou, paused, done, failed

	/// Finished phases end the activity; the rest keep it on screen.
	public var isFinal: Bool { self == .done || self == .failed }

	public var label: String {
		switch self {
		case .running: "Working"
		case .needsYou: "Needs you"
		case .paused: "Paused"
		case .done: "Done"
		case .failed: "Failed"
		}
	}
}

/// The part of an activity that changes. Kept tiny: ActivityKit caps the encoded payload at 4 KB
/// and a push update has to fit it too.
public struct SessionActivityState: Codable, Hashable, Sendable {
	public var phase: SessionActivityPhase
	/// One short line of progress, if the app has one. Never a provider id.
	public var step: String?

	public init(phase: SessionActivityPhase, step: String? = nil) {
		self.phase = phase
		self.step = step.map { String($0.prefix(Self.maxStepLength)) }
	}

	public static let maxStepLength = 40
}

/// The unchanging part: who is working, on what, since when.
public struct SessionActivityInfo: Codable, Hashable, Sendable {
	public var agentID: String
	public var agentName: String
	public var task: String
	public var startedAt: Date

	public init(agentID: String, agentName: String, task: String, startedAt: Date = Date()) {
		self.agentID = agentID
		self.agentName = agentName
		self.task = String(task.prefix(80))
		self.startedAt = startedAt
	}
}

#if canImport(ActivityKit) && os(iOS)
	public struct SessionActivityAttributes: ActivityAttributes {
		public typealias ContentState = SessionActivityState

		public var info: SessionActivityInfo

		public init(info: SessionActivityInfo) { self.info = info }
	}

	/// Starts, updates and ends the Live Activity for an agent's run. Local only: with the app in
	/// the background the activity stays as it was until it goes stale (30 minutes), because
	/// updating it then needs a server push. Failure to start (activities off, too many) is silent.
	@MainActor
	public final class SessionActivityController {
		public static let shared = SessionActivityController()

		/// How long an activity may go without an update before the system marks it stale.
		static let staleAfter: TimeInterval = 30 * 60

		public init() {}

		public func start(agentID: String, agentName: String, task: String) {
			guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
			if existing(agentID) != nil {
				update(agentID: agentID, state: SessionActivityState(phase: .running))
				return
			}
			let info = SessionActivityInfo(agentID: agentID, agentName: agentName, task: task)
			let content = ActivityContent(
				state: SessionActivityState(phase: .running),
				staleDate: Date().addingTimeInterval(Self.staleAfter))
			_ = try? Activity.request(
				attributes: SessionActivityAttributes(info: info), content: content, pushType: nil)
		}

		public func update(agentID: String, state: SessionActivityState) {
			guard existing(agentID) != nil else { return }
			if state.phase.isFinal {
				end(agentID: agentID, state: state)
				return
			}
			let content = ActivityContent(
				state: state, staleDate: Date().addingTimeInterval(Self.staleAfter))
			Task { await Self.apply(agentID: agentID, content: content, dismissal: nil) }
		}

		/// Ends the activity. A finished run lingers briefly so the result is seen; a failure stays
		/// until dismissed.
		public func end(agentID: String, state: SessionActivityState) {
			guard existing(agentID) != nil else { return }
			let content = ActivityContent(state: state, staleDate: nil)
			let policy: ActivityUIDismissalPolicy =
				state.phase == .failed ? .default : .after(Date().addingTimeInterval(15 * 60))
			Task { await Self.apply(agentID: agentID, content: content, dismissal: policy) }
		}

		/// Keeps the activity in step with what the app last saw: live means running or paused,
		/// otherwise it is done.
		public func sync(agentID: String, isLive: Bool, isPaused: Bool) {
			guard existing(agentID) != nil else { return }
			if isLive {
				update(
					agentID: agentID,
					state: SessionActivityState(phase: isPaused ? .paused : .running))
			} else {
				end(agentID: agentID, state: SessionActivityState(phase: .done))
			}
		}

		/// Looks the activity up and uses it in one non-isolated place: `Activity` is not Sendable, so
		/// it must not cross from the main actor into a task.
		private nonisolated static func apply(
			agentID: String, content: ActivityContent<SessionActivityState>,
			dismissal: ActivityUIDismissalPolicy?
		) async {
			guard
				let activity = Activity<SessionActivityAttributes>.activities.first(where: {
					$0.attributes.info.agentID == agentID
				})
			else { return }
			if let dismissal {
				await activity.end(content, dismissalPolicy: dismissal)
			} else {
				await activity.update(content)
			}
		}

		private func existing(_ agentID: String) -> Activity<SessionActivityAttributes>? {
			Activity<SessionActivityAttributes>.activities.first {
				$0.attributes.info.agentID == agentID
			}
		}
	}
#else
	/// No Live Activities off iOS: the same calls, doing nothing, so callers need no guard.
	@MainActor
	public final class SessionActivityController {
		public static let shared = SessionActivityController()
		public init() {}
		public func start(agentID: String, agentName: String, task: String) {}
		public func update(agentID: String, state: SessionActivityState) {}
		public func end(agentID: String, state: SessionActivityState) {}
		public func sync(agentID: String, isLive: Bool, isPaused: Bool) {}
	}
#endif
