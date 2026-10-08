import Foundation

/// What a tab-bar badge says. A count up to 99, "99+" beyond, and nothing at zero: system badges
/// with one flat accent fill (the decision on the iPad/iPhone handoff), no gradient or ring.
public enum ShellBadgeText {
	public static let cap = 99

	public static func text(count: Int) -> String? {
		if count <= 0 { return nil }
		return count > cap ? "\(cap)+" : String(count)
	}
}
