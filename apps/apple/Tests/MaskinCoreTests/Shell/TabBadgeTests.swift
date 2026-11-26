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

	@Test("VoiceOver hears the count after the tab name")
	func spoken() {
		#expect(TabBadge.none.spokenValue(needsYou: false) == nil)
		#expect(TabBadge.dot.spokenValue(needsYou: true) == "unread")
		#expect(TabBadge.count(8).spokenValue(needsYou: false) == "8 unread")
		#expect(TabBadge.count(15).spokenValue(needsYou: true) == "15 need you")
		#expect(TabBadge.count(250).spokenValue(needsYou: false) == "99+ unread")
	}
}
