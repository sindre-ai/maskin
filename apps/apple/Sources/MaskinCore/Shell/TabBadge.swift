import Foundation

/// What a tab-bar item shows: nothing, a count, or a bare dot. Pure formatting so the rules are
/// testable: a count shows up to 99 and then "99+"; unread with no count to give is a dot.
public enum TabBadge: Equatable, Sendable {
	case none
	case count(Int)
	case dot

	public static let maxCount = 99

	/// `count` open items; `hasUnreadWithoutCount` is true when something is unread but there is no
	/// number worth showing (For you: updates to read but no decision waiting).
	public static func make(count: Int, hasUnreadWithoutCount: Bool = false) -> TabBadge {
		if count > 0 { return .count(count) }
		return hasUnreadWithoutCount ? .dot : .none
	}

	/// The badge text; `nil` shows no badge. A dot is the empty string, the convention UIKit's tab
	/// bar renders as a dot.
	public var label: String? {
		switch self {
		case .none: nil
		case .count(let n): n > Self.maxCount ? "\(Self.maxCount)+" : (n > 0 ? "\(n)" : nil)
		case .dot: ""
		}
	}
}
