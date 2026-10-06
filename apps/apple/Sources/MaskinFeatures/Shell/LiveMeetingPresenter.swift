import MaskinCore
import SwiftUI

/// A request to open the full-screen live meeting.
public enum LiveMeetingRequest: Identifiable {
	/// The For you "Live" button: the daily briefing with the Chief of Staff. Ending just closes.
	case dailyBriefing
	/// An ad hoc call with `lead`, inside the thread `chat` shows. Ending posts a note into it.
	case thread(chat: ChatStore, lead: ChatParticipant)

	public var id: String {
		switch self {
		case .dailyBriefing: "briefing"
		case .thread(let chat, _): "thread:\(MainActor.assumeIsolated { chat.conversationID })"
		}
	}
}

/// How a screen opens the live meeting. `MainShell` provides it; without a shell (previews) it does
/// nothing. A chat thread's Live pill calls
/// `@Environment(\.liveMeeting) var liveMeeting` then `liveMeeting.present(.thread(chat: store, lead: agent))`.
public struct LiveMeetingPresenter: Sendable {
	public var present: @MainActor @Sendable (LiveMeetingRequest) -> Void

	public init(present: @escaping @MainActor @Sendable (LiveMeetingRequest) -> Void) {
		self.present = present
	}

	public static let none = LiveMeetingPresenter { _ in }
}

private struct LiveMeetingPresenterKey: EnvironmentKey {
	static let defaultValue = LiveMeetingPresenter.none
}

extension EnvironmentValues {
	public var liveMeeting: LiveMeetingPresenter {
		get { self[LiveMeetingPresenterKey.self] }
		set { self[LiveMeetingPresenterKey.self] = newValue }
	}
}
