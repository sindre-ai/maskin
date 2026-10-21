import Foundation
import Testing

@testable import MaskinCore

private func card(
	status: String? = "active", summary: String = "A summary.", age: TimeInterval = 60,
	decision: Bool = true
) -> ForYouCard {
	ForYouCard(
		id: "c", objectTitle: "Object", objectType: "bet", status: status, latestEventId: 3,
		latestActivityAt: Date().addingTimeInterval(-age),
		mention: ForYouMention(
			eventId: 1, actorId: "a", content: "Mention",
			decision: decision
				? DecisionPrompt(
					title: "T", summary: summary, ask: "Ask?",
					options: [DecisionOption(label: "Go", recommended: true)]) : nil))
}

@Suite("ForYouUrgency")
struct ForYouUrgencyTests {
	@Test func aBlockedObjectBlocksTheAgentThatRaisedIt() {
		let u = ForYouUrgency.make(for: card(status: "blocked"), agent: "Strategist")
		#expect(u?.kind == .blocking)
		#expect(u?.text == "Holding up Strategist")
		#expect(u?.isHot == true)
	}

	@Test func aDueDateInTheAgentsWordsBecomesTheChip() {
		let u = ForYouUrgency.make(for: card(summary: "The note is due 15 Oct, before the call."), agent: "Forge")
		#expect(u?.kind == .due)
		#expect(u?.text == "Due 15 Oct")
	}

	@Test func aCardThatHasWaitedADayShowsOneNeutralChip() {
		let u = ForYouUrgency.make(for: card(age: 2 * 86_400 + 60), agent: "Forge")
		#expect(u?.kind == .waiting)
		#expect(u?.text == "Asked 2 days ago")
		#expect(u?.isHot == false)
	}

	@Test func aFreshAskHasNoChip() {
		#expect(ForYouUrgency.make(for: card(), agent: "Forge") == nil)
	}

	@Test func blockingOutranksDueOutranksWaiting() {
		let blocking = ForYouUrgency.make(for: card(status: "blocked"), agent: nil)
		let due = ForYouUrgency.make(for: card(summary: "due 3 Nov"), agent: nil)
		let waiting = ForYouUrgency.make(for: card(age: 3 * 86_400), agent: nil)
		#expect(ForYouUrgency.rank(of: blocking) < ForYouUrgency.rank(of: due))
		#expect(ForYouUrgency.rank(of: due) < ForYouUrgency.rank(of: waiting))
		#expect(ForYouUrgency.rank(of: waiting) < ForYouUrgency.rank(of: nil))
		#expect(blocking?.text == "Holding up work")
	}

	@Test func intentsSeparateApprovalsFromQuestions() {
		let decision = card()
		let thread = card(decision: false)
		#expect(ForYouIntent.approvals.matches(decision, urgency: nil))
		#expect(!ForYouIntent.approvals.matches(thread, urgency: nil))
		#expect(ForYouIntent.questions.matches(thread, urgency: nil))
		let blocked = ForYouUrgency.make(for: card(status: "blocked"), agent: nil)
		#expect(ForYouIntent.blocking.matches(decision, urgency: blocked))
		#expect(!ForYouIntent.blocking.matches(decision, urgency: nil))
	}
}
