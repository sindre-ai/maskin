import Foundation

/// What the call Live Activity needs from the platform (ActivityKit in the app target).
@MainActor
public protocol CallActivityHosting: AnyObject {
	/// False when the person turned Live Activities off: the controller then does nothing, silently.
	var areActivitiesEnabled: Bool { get }
	/// Requests the one call activity. Ends any other call activity first.
	func start(
		callId: String, agentName: String, workspaceId: String,
		conversationId: String?, state: LiveCallActivityState)
	func update(state: LiveCallActivityState) async
	/// Ends every call activity.
	func endAll() async
}

/// The live call the card's Mute and End buttons act on. The call center registers its controls while
/// a call is up and clears them when it ends, so a button that outlives the call does nothing. A Live
/// Activity intent runs in the app process, so a plain in-memory handle is enough.
@MainActor
public final class LiveCallControl {
	public static let shared = LiveCallControl()

	public enum Outcome: Equatable, Sendable {
		case performed
		/// No call is live: the card is stale and should be taken down.
		case noLiveCall
	}

	private var toggleMute: (() -> Void)?
	private var hangUp: (() -> Void)?

	public init() {}

	public var isRegistered: Bool { hangUp != nil }

	public func register(toggleMute: @escaping () -> Void, hangUp: @escaping () -> Void) {
		self.toggleMute = toggleMute
		self.hangUp = hangUp
	}

	public func clear() {
		toggleMute = nil
		hangUp = nil
	}

	/// Runs the action on the live call. With no call, nothing happens and the caller is told, so it
	/// can end the stale card.
	@discardableResult
	public func perform(_ action: LiveCallAction) -> Outcome {
		guard let toggleMute, let hangUp else { return .noLiveCall }
		switch action {
		case .toggleMute: toggleMute()
		case .hangUp: hangUp()
		}
		return .performed
	}
}

/// Starts the call activity when a call connects, follows it, ends it when the call does. One call at
/// a time. Updates are rate-limited (`minInterval`), except a mute change, which lands at once because
/// the person just pressed it; the last change always lands, after the interval.
@MainActor
public final class CallActivityController {
	/// Set at launch on iOS; `nil` where Live Activities don't exist.
	public static var shared: CallActivityController?

	public static let defaultMinInterval: TimeInterval = 1

	private let host: any CallActivityHosting
	private let now: () -> Date
	private let minInterval: TimeInterval

	private var callId: String?
	private var startedAt: Date?
	/// What the card shows now; nil while no card is up.
	private var shown: LiveCallActivityState?
	private var pending: LiveCallActivityState?
	private var lastUpdate: Date?
	private var flush: Task<Void, Never>?
	/// The card was removed by the system or swiped away: leave it gone for the rest of this call.
	private var removedByPerson = false

	public init(
		host: any CallActivityHosting, minInterval: TimeInterval = CallActivityController.defaultMinInterval,
		now: @escaping () -> Date = { Date() }
	) {
		self.host = host
		self.minInterval = minInterval
		self.now = now
	}

	public var isShowing: Bool { shown != nil }

	/// The call connected. A second call while one is up is ignored.
	public func callStarted(
		callId: String, agentName: String, workspaceId: String, conversationId: String?, startedAt: Date,
		snapshot: LiveCallSnapshot
	) {
		guard self.callId == nil else { return }
		self.callId = callId
		self.startedAt = startedAt
		removedByPerson = false
		guard host.areActivitiesEnabled, !snapshot.failed else { return }
		let state = snapshot.state(startedAt: startedAt)
		let name = agentName.trimmingCharacters(in: .whitespacesAndNewlines)
		let shownName = name.isEmpty ? "Maskin" : String(name.prefix(MeetingActivityState.maxNameLength))
		shown = state
		lastUpdate = now()
		host.start(
			callId: callId, agentName: shownName, workspaceId: workspaceId, conversationId: conversationId, state: state)
	}

	/// The call's state, polled by the call center. A failed call ends the card.
	/// `immediate` skips the rate limit (a mute the person just pressed).
	public func sync(_ snapshot: LiveCallSnapshot, immediate: Bool = false) {
		guard callId != nil, let startedAt else { return }
		if snapshot.failed {
			callEnded()
			return
		}
		guard shown != nil, !removedByPerson else { return }
		let next = snapshot.state(startedAt: startedAt)
		guard next != (pending ?? shown) else { return }
		let elapsed = lastUpdate.map { now().timeIntervalSince($0) } ?? .infinity
		if immediate || elapsed >= minInterval {
			send(next)
		} else {
			pending = next
			scheduleFlush(after: minInterval - elapsed)
		}
	}

	/// The call is over (hung up from the app or the card, or it failed).
	public func callEnded() {
		flush?.cancel()
		flush = nil
		pending = nil
		callId = nil
		startedAt = nil
		lastUpdate = nil
		removedByPerson = false
		shown = nil
		// Always asks the host, which also covers a card this controller lost track of.
		Task { [host] in await host.endAll() }
	}

	/// The system ended the card, or it was swiped away, while the call goes on. It does not come back
	/// until the next call.
	public func cardRemoved() {
		flush?.cancel()
		flush = nil
		pending = nil
		shown = nil
		removedByPerson = callId != nil
	}

	/// At launch no call survives, so every call card is stale. Also the answer to a button pressed on a
	/// card with no call behind it.
	public func endStaleCards() async {
		guard callId == nil else { return }
		await host.endAll()
	}

	private func send(_ state: LiveCallActivityState) {
		flush?.cancel()
		flush = nil
		pending = nil
		shown = state
		lastUpdate = now()
		Task { [host] in await host.update(state: state) }
	}

	private func scheduleFlush(after delay: TimeInterval) {
		guard flush == nil else { return }
		flush = Task { [weak self] in
			try? await Task.sleep(for: .seconds(max(0, delay)))
			guard !Task.isCancelled, let self else { return }
			self.flush = nil
			if let state = self.pending, self.callId != nil { self.send(state) }
		}
	}
}
