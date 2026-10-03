import Foundation
import Testing

@testable import MaskinCore

struct ForYouCardTests {
	private func card(content: String?, decision: DecisionPrompt? = nil, title: String? = "Onboarding bet")
		-> ForYouCard
	{
		ForYouCard(
			id: "o1", objectTitle: title,
			mention: content.map { ForYouMention(eventId: 5, content: $0, decision: decision) })
	}

	@Test func decisionTitleLeadsAndOptionsAreTheAgentsOwn() {
		let d = DecisionPrompt(
			title: "Is the bet worth running?", summary: "3 of 5 stall.", ask: "I will not ship alone.",
			options: [
				DecisionOption(label: "Hold", consequences: ["Nothing ships"]),
				DecisionOption(label: "7-day window", consequences: ["Ships tomorrow"], recommended: true),
			])
		let c = card(content: "see below", decision: d)
		#expect(c.kind == .decision)
		#expect(c.headline == "Is the bet worth running?")
		#expect(c.body == "")
		#expect(c.decision?.recommended?.label == "7-day window")
		#expect(c.contextTitle == "Onboarding bet")
	}

	@Test func plainMentionTakesItsFirstSentenceAsHeadline() {
		let c = card(content: "Can you check the pricing page? I changed the tiers yesterday.")
		#expect(c.kind == .thread)
		#expect(c.headline == "Can you check the pricing page?")
		#expect(c.body == "I changed the tiers yesterday.")
	}

	@Test func markdownScaffoldingIsSkipped() {
		let c = card(content: "## Heads up\nThe export failed twice.")
		#expect(c.headline == "Heads up")
		#expect(c.body == "The export failed twice.")
	}

	@Test func overlongOpeningIsCappedAndKeptWholeInTheBody() {
		let long = "one two three four five six seven eight nine ten eleven twelve"
		let c = card(content: long)
		#expect(c.headline == "one two three four five six seven eight nine…")
		#expect(c.body == long)
	}

	@Test func fallsBackToObjectTitleWhenThereIsNoMention() {
		let c = card(content: nil)
		#expect(c.headline == "Onboarding bet")
		#expect(c.contextTitle == nil)  // not printed twice
		#expect(card(content: nil, title: nil).headline == "Untitled")
	}

	@Test func heldNoteSaysNothingUntilADayHasPassed() {
		let now = Date()
		#expect(ForYouFormat.heldNote(since: now.addingTimeInterval(-3600), now: now) == nil)
		#expect(ForYouFormat.heldNote(since: now.addingTimeInterval(-86_400), now: now) == "Waiting 1 day")
		#expect(ForYouFormat.heldNote(since: now.addingTimeInterval(-3 * 86_400), now: now) == "Waiting 3 days")
		#expect(ForYouFormat.heldNote(since: now.addingTimeInterval(-9 * 86_400), now: now) == "Waiting over a week")
	}
}
