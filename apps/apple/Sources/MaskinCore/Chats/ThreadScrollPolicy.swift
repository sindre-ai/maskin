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

/// How the thread lays out its rows.
public enum ThreadRendering {
	/// Threads shorter than this render in a plain stack. A lazy stack estimates the height of rows
	/// it has not built; under repeated rebuilds plus the bottom scroll anchor those estimates
	/// mis-measure (blank gaps, content sliding). Below this size building every row is cheap.
	/// Longer threads keep the lazy stack.
	public static let eagerRowLimit = 100

	public static func usesLazyStack(rowCount: Int) -> Bool { rowCount >= eagerRowLimit }
}
