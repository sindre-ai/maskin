import Foundation
import Testing

@testable import MaskinCore

@Suite("Briefing cards")
struct BriefingCardsTests {
	private var calendar: Calendar {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(identifier: "UTC")!
		return c
	}

	private func date(hour: Int) -> Date {
		calendar.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: hour))!
	}

	@Test("a loaded briefing becomes the first card, greeted by first name")
	func daily() {
		let cards = BriefingCards.cards(
			brief: .loaded(ForYouBrief(markdown: "# Today\nAll quiet.")), firstName: "Sebastian Krumhausen",
			now: date(hour: 9), calendar: calendar)
		#expect(cards.count == 1)
		#expect(cards[0].title == "Good morning, Sebastian")
		#expect(cards[0].unit == "DAILY")
		#expect(cards[0].id == "daily-2026-10-07")
		#expect(cards[0].formatLabel == "READ · 1 MIN")
	}

	@Test("the greeting follows the time of day and copes with no name")
	func greeting() {
		#expect(BriefingCards.greeting(firstName: nil, now: date(hour: 14), calendar: calendar) == "Good afternoon")
		#expect(BriefingCards.greeting(firstName: "Ada", now: date(hour: 20), calendar: calendar) == "Good evening, Ada")
	}

	@Test("nothing to show while loading, failed, or empty")
	func empty() {
		#expect(BriefingCards.cards(brief: .loading, firstName: nil).isEmpty)
		#expect(BriefingCards.cards(brief: .failed("x"), firstName: nil).isEmpty)
		#expect(BriefingCards.cards(brief: .loaded(ForYouBrief(markdown: "  \n")), firstName: nil).isEmpty)
	}

	@Test("read time rounds up at 200 words a minute")
	func readTime() {
		#expect(BriefingCards.readMinutes("one two three") == 1)
		#expect(BriefingCards.readMinutes(Array(repeating: "word", count: 401).joined(separator: " ")) == 3)
	}

	@Test("seen cards are remembered")
	func seen() {
		let suite = "briefing-seen-\(UUID().uuidString)"
		let defaults = UserDefaults(suiteName: suite)!
		defer { defaults.removePersistentDomain(forName: suite) }
		let seen = BriefingSeen(defaults: defaults)
		#expect(!seen.isSeen("daily-1"))
		seen.markSeen("daily-1")
		#expect(seen.isSeen("daily-1"))
		#expect(!seen.isSeen("daily-2"))
	}
}
