import Foundation

/// What the meeting Live Activity needs from the platform (ActivityKit in the app target).
@MainActor
public protocol MeetingActivityHosting: AnyObject {
	func start(meetingId: String, workspaceId: String, conversationId: String?, state: MeetingActivityState)
	func update(state: MeetingActivityState) async
	func end() async
}

/// The live call the Lock Screen's Mute and End buttons act on. The meeting screen registers its
/// controls while a call is up and clears them when it closes, so an intent that outlives the call
/// does nothing. A Live Activity intent runs in the app process, which is why this can be a plain
/// in-memory handle.
@MainActor
public final class MeetingCallControl {
	public static let shared = MeetingCallControl()

	private var toggleMute: (() -> Void)?
	private var hangUp: (() -> Void)?

	public var isRegistered: Bool { hangUp != nil }

	public func register(toggleMute: @escaping () -> Void, hangUp: @escaping () -> Void) {
		self.toggleMute = toggleMute
		self.hangUp = hangUp
	}

	public func clear() {
		toggleMute = nil
		hangUp = nil
	}

	public func performToggleMute() { toggleMute?() }
	public func performHangUp() { hangUp?() }
}

/// Starts the meeting activity when a call connects, follows mute, ends it when the call does.
/// One call at a time.
@MainActor
public final class MeetingActivityController {
	/// Set at launch on iOS; `nil` where Live Activities don't exist.
	public static var shared: MeetingActivityController?

	private let host: any MeetingActivityHosting
	private var state: MeetingActivityState?

	public init(host: any MeetingActivityHosting) { self.host = host }

	public var isShowing: Bool { state != nil }

	public func callStarted(
		meetingId: String, workspaceId: String, conversationId: String?, name: String,
		startedAt: Date, kind: MeetingActivityState.Kind
	) {
		let next = MeetingActivityState(name: name, startedAt: startedAt, kind: kind)
		state = next
		host.start(meetingId: meetingId, workspaceId: workspaceId, conversationId: conversationId, state: next)
	}

	public func muteChanged(_ muted: Bool) {
		guard var current = state, current.muted != muted else { return }
		current.muted = muted
		state = current
		Task { await host.update(state: current) }
	}

	public func callEnded() {
		guard state != nil else { return }
		state = nil
		Task { await host.end() }
	}
}
