import Foundation

/// What the thread's scroll position does when its newest row changes.
public enum ThreadScrollAction: Equatable, Sendable {
	/// Still settling after open: snap to the bottom without animating.
	case jump
	/// The reader is at the bottom (or just sent): follow with an animation.
	case follow
	/// The reader is reading history: leave them, and count the message for the jump pill.
	case countUnseen
}

public enum ThreadScrollPolicy {
	public static func onNewestChanged(
		followingOpen: Bool, isAtBottom: Bool, newestIsMine: Bool
	) -> ThreadScrollAction {
		if followingOpen { return .jump }
		if isAtBottom || newestIsMine { return .follow }
		return .countUnseen
	}
}
