import Foundation
import Testing

@testable import MaskinCore

struct ForYouHeaderTests {
	private var utc: Calendar {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC")!
		return calendar
	}

	private func date(_ day: Int, month: Int = 10) -> Date {
		utc.date(from: DateComponents(year: 2026, month: month, day: day, hour: 12))!
	}

	private func card(_ id: String, title: String = "Is the onboarding bet worth running?") -> ForYouCard {
		ForYouCard(
			id: id, objectTitle: "Onboarding", objectType: "bet",
			mention: ForYouMention(
				eventId: 1, actorId: "forge", content: "ask",
				decision: DecisionPrompt(
					title: title, summary: "3 of 5 stall.", ask: "I cannot.",
					options: [DecisionOption(label: "Ship", consequences: ["Ships"], recommended: true)])))
	}

	@Test func dateLineIsWeekdayDayMonthInCapitals() {
		#expect(ForYouHeader.dateLine(date(18), calendar: utc) == "SUN 18 OCT")
		#expect(ForYouHeader.dateLine(date(5, month: 11), calendar: utc) == "THU 5 NOV")
	}

	@Test func spokenDateIsWrittenOut() {
		#expect(ForYouHeader.spokenDate(date(18), calendar: utc) == "Sunday 18 October")
	}

	@Test func theSentenceCountsTheDecisionsWaiting() {
		let one = [FeedEntry(card: card("a"), bucket: .needs)]
		#expect(ForYouHeader.summary(blocking: one, loaded: true) == "1 decision is waiting on you.")
		let two = one + [FeedEntry(card: card("b", title: "Ship it"), bucket: .needs)]
		#expect(ForYouHeader.summary(blocking: two, loaded: true) == "2 decisions are waiting on you.")
	}

	@Test func nothingOpenSaysNothingIsBlocked() {
		#expect(ForYouHeader.summary(blocking: [], loaded: true) == "Nothing is blocked on you.")
	}

	@Test func theProseAddsWhatTheReaderAnsweredAndWhoCarriesOn() {
		let one = [FeedEntry(card: card("a"), bucket: .needs)]
		#expect(
			ForYouHeader.summary(blocking: one, answered: 3, carryingOn: ["Developer"], loaded: true)
				== "1 decision is waiting on you. You\u{2019}ve answered 3 so far, and Developer is carrying on.")
		#expect(
			ForYouHeader.summary(blocking: [], answered: 2, carryingOn: ["Developer", "SEO Researcher"], loaded: true)
				== "Nothing is blocked on you. You\u{2019}ve answered 2 so far, and Developer and SEO Researcher are carrying on.")
	}

	@Test func aPartWithNoSourceIsLeftOut() {
		let one = [FeedEntry(card: card("a"), bucket: .needs)]
		#expect(
			ForYouHeader.summary(blocking: one, answered: 1, carryingOn: [], loaded: true)
				== "1 decision is waiting on you. You\u{2019}ve answered 1 so far.")
		#expect(
			ForYouHeader.summary(blocking: one, answered: 0, carryingOn: ["Forge"], loaded: true)
				== "1 decision is waiting on you. Forge is carrying on.")
	}

	@Test func namesReadAsAnEnglishList() {
		#expect(ForYouHeader.naturalList([]) == nil)
		#expect(ForYouHeader.naturalList(["A", "B", "C"]) == "A, B and C")
	}

	@Test func nothingIsClaimedBeforeTheFeedHasLoaded() {
		#expect(ForYouHeader.summary(blocking: [], loaded: false) == nil)
	}

	@Test func theGreetingFollowsTheHourAndUsesTheFirstName() {
		func at(_ hour: Int) -> Date { utc.date(from: DateComponents(year: 2026, month: 10, day: 18, hour: hour))! }
		#expect(ForYouHeader.greeting(name: "Sebastian Krumhausen", at: at(9), calendar: utc) == "Good morning, Sebastian")
		#expect(ForYouHeader.greeting(name: "Sebastian", at: at(14), calendar: utc) == "Good afternoon, Sebastian")
		#expect(ForYouHeader.greeting(name: "Sebastian", at: at(20), calendar: utc) == "Good evening, Sebastian")
		#expect(ForYouHeader.greeting(name: nil, at: at(9), calendar: utc) == "Good morning")
		#expect(ForYouHeader.greeting(name: "  ", at: at(9), calendar: utc) == "Good morning")
	}
}
