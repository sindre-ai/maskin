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

	@Test func theSentenceNamesTheAgentAndTheMostUrgentAsk() {
		let blocking = [FeedEntry(card: card("a"), bucket: .needs), FeedEntry(card: card("b", title: "Ship it"), bucket: .needs)]
		let text = ForYouHeader.summary(blocking: blocking, loaded: true, sender: { _ in "Forge" })
		#expect(text == "Forge needs a call: Is the onboarding bet worth running?")
	}

	@Test func aTitleWithoutPunctuationGetsAFullStop() {
		let blocking = [FeedEntry(card: card("a", title: "Acme's note before Thursday"), bucket: .needs)]
		let text = ForYouHeader.summary(blocking: blocking, loaded: true, sender: { _ in "Forge" })
		#expect(text == "Forge needs a call: Acme's note before Thursday.")
	}

	@Test func nothingOpenSaysNothingIsBlocked() {
		let text = ForYouHeader.summary(blocking: [], loaded: true, sender: { _ in "Forge" })
		#expect(text == "Nothing is blocked on you.")
	}

	@Test func nothingIsClaimedBeforeTheFeedHasLoaded() {
		#expect(ForYouHeader.summary(blocking: [], loaded: false, sender: { _ in nil }) == nil)
	}

	@Test func anAskWithNoKnownAgentGivesNoSentence() {
		let blocking = [FeedEntry(card: card("a"), bucket: .needs)]
		#expect(ForYouHeader.summary(blocking: blocking, loaded: true, sender: { _ in nil }) == nil)
	}
}
