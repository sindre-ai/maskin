import Testing

@testable import MaskinCore

@Suite("TabBadge")
struct TabBadgeTests {
	@Test("a count shows as its number")
	func count() {
		#expect(TabBadge.make(count: 3).label == "3")
		#expect(TabBadge.make(count: 99).label == "99")
	}

	@Test("past 99 it reads 99+")
	func overflow() {
		#expect(TabBadge.make(count: 100).label == "99+")
		#expect(TabBadge.make(count: 4_000).label == "99+")
	}

	@Test("zero with nothing unread shows nothing")
	func none() {
		#expect(TabBadge.make(count: 0) == .none)
		#expect(TabBadge.make(count: 0).label == nil)
		#expect(TabBadge.make(count: -2).label == nil)
	}

	@Test("unread with no count is a dot")
	func dot() {
		#expect(TabBadge.make(count: 0, hasUnreadWithoutCount: true) == .dot)
		#expect(TabBadge.make(count: 0, hasUnreadWithoutCount: true).label == "")
	}

	@Test("a count wins over the dot")
	func countWins() {
		#expect(TabBadge.make(count: 2, hasUnreadWithoutCount: true) == .count(2))
	}
}
