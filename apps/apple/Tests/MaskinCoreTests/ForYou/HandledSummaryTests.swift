import Foundation
import Testing

@testable import MaskinCore

private func entry(_ kind: DecisionRecord.Kind, phase: DecisionRecord.Phase) -> FeedEntry {
	FeedEntry(
		card: ForYouCard(id: "a", objectTitle: "Retry window", objectType: "bet", latestEventId: 1),
		bucket: .done, record: DecisionRecord(kind: kind, phase: phase))
}

@Suite("HandledSummary")
struct HandledSummaryTests {
	@Test func aTakenCallNamesTheObjectAndWhoCarriesOn() {
		let s = HandledSummary.make(
			for: entry(.option("7-day window"), phase: .held(until: .distantFuture)), sender: "Forge")
		#expect(s?.mark == .done)
		#expect(s?.label == "7-day window")
		#expect(s?.detail == "Retry window \u{00B7} Forge carries on")
		#expect(s?.canUndo == true)
	}

	@Test func aSentCallCannotBeUndone() {
		let s = HandledSummary.make(for: entry(.option("Ship"), phase: .sent), sender: "Forge")
		#expect(s?.canUndo == false)
	}

	@Test func aSentDismissalCanStillBeUndone() {
		let s = HandledSummary.make(for: entry(.dismissed, phase: .sent), sender: nil)
		#expect(s?.label == "Marked read")
		#expect(s?.canUndo == true)
	}

	@Test func aHoldSaysTheAgentHasTheReason() {
		let s = HandledSummary.make(for: entry(.option("Hold for now"), phase: .sent), sender: "Forge")
		#expect(s?.mark == .held)
		#expect(s?.label == "Held")
		#expect(s?.detail == "Retry window \u{00B7} Forge has your reason")
	}

	@Test func aQueuedCallWaitsForTheNetwork() {
		let s = HandledSummary.make(for: entry(.option("Ship"), phase: .queued), sender: "Forge")
		#expect(s?.mark == .queued)
		#expect(s?.label == "Queued \u{00B7} Ship")
		#expect(s?.detail == "Retry window \u{00B7} sends when you\u{2019}re back")
	}

	@Test func anOpenCardHasNoSummary() {
		let open = FeedEntry(card: ForYouCard(id: "a"), bucket: .needs)
		#expect(HandledSummary.make(for: open, sender: nil) == nil)
	}
}
