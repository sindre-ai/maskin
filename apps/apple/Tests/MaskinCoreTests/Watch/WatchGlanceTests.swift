import Foundation
import Testing

@testable import MaskinCore

@Suite("Watch glance helpers")
struct WatchGlanceTests {
	private func option(_ label: String, recommended: Bool = false) -> DecisionOption {
		DecisionOption(label: label, recommended: recommended)
	}

	@Test("every option is shown in the iPhone's order, not capped")
	func allOptions() {
		let all = [option("A"), option("B"), option("C", recommended: true), option("D"), option("E")]
		#expect(WatchDecisionOptions.all(all) == all)
	}

	@Test("confirmation follows the option's own destructive flag")
	func confirmation() {
		#expect(WatchDecisionOptions.needsConfirmation(DecisionOption(label: "Wire $5k", destructive: true)))
		#expect(!WatchDecisionOptions.needsConfirmation(option("Ship it", recommended: true)))
	}

	@Test("hold is recognised by word, not substring")
	func hold() {
		#expect(WatchDecisionOptions.isHold(option("Hold for now")))
		#expect(!WatchDecisionOptions.isHold(option("Withhold payment")))
	}

	@Test("receipts read Sent 7 and Held")
	func receipts() {
		#expect(WatchDecisionOptions.receiptTitle(for: "Send 7 follow-ups") == "Sent 7")
		#expect(WatchDecisionOptions.receiptTitle(for: "Send it") == "Sent")
		#expect(WatchDecisionOptions.receiptTitle(for: "Hold") == "Held")
		#expect(WatchDecisionOptions.receiptTitle(for: "Revise copy") == "Revise copy")
	}

	@Test("a hold shows the reason, or just Held when skipped")
	func heldNote() {
		#expect(WatchDecisionOptions.heldNote(reason: " Need more time ") == "Held \u{00B7} your reason: Need more time")
		#expect(WatchDecisionOptions.heldNote(reason: "  ") == "Held")
		#expect(WatchDecisionOptions.heldNote(reason: nil) == "Held")
	}

	@Test("markdown becomes plain sentences")
	func plainText() {
		let md = "# Good morning\n\n- **Two** things need [you](https://x.io)\n\n\n\nUse `Hold`."
		#expect(WatchBriefingText.plain(md) == "Good morning\n\nTwo things need you\n\nUse Hold.")
	}

	@Test("the big capsule takes the recommended option, else the first that is not a hold")
	func primary() {
		let options = [option("Hold"), option("Ship it"), option("Lower", recommended: true)]
		#expect(WatchDecisionOptions.primary(options)?.label == "Lower")
		#expect(WatchDecisionOptions.primary([option("Hold for now"), option("Ship it")])?.label == "Ship it")
		#expect(WatchDecisionOptions.primary([option("Hold")]) == nil)
		#expect(WatchDecisionOptions.primary([]) == nil)
	}

	@Test("Hold is the card's own, never invented")
	func holdOption() {
		#expect(WatchDecisionOptions.hold([option("Ship it"), option("Hold for now")])?.label == "Hold for now")
		#expect(WatchDecisionOptions.hold([option("Ship it"), option("Withhold payment")]) == nil)
	}

	@Test("All options lists every option but the holds, in order, and More needs a second one")
	func listed() {
		let options = [option("A"), option("Hold"), option("B", recommended: true), option("C")]
		#expect(WatchDecisionOptions.listed(options).map(\.label) == ["A", "B", "C"])
		#expect(WatchDecisionOptions.hasMore(options))
		#expect(!WatchDecisionOptions.hasMore([option("Ship it", recommended: true), option("Hold")]))
		#expect(!WatchDecisionOptions.hasMore([]))
	}

	@Test("the header says which decision of how many")
	func position() {
		#expect(WatchDecisionOptions.position(0, of: 3) == "1 of 3")
		#expect(WatchDecisionOptions.position(2, of: 3) == "3 of 3")
	}

	@Test("the reason is the first sentence, and a decimal point does not end it")
	func reasonLine() {
		#expect(WatchDecisionOptions.reasonLine("7 people. Webhook fix shipped.") == "7 people.")
		#expect(WatchDecisionOptions.reasonLine("Spends $2.4k from the budget. Cannot be refunded.") == "Spends $2.4k from the budget.")
		#expect(WatchDecisionOptions.reasonLine("**CTO ruled**, Developer is waiting on you") == "CTO ruled, Developer is waiting on you")
		#expect(WatchDecisionOptions.reasonLine("  ") == nil)
	}

	@Test("the offline header reads the age of the snapshot")
	func offlineHeader() {
		let now = Date(timeIntervalSince1970: 100_000)
		#expect(WatchDecisionOptions.offlineHeader(updatedAt: now.addingTimeInterval(-12 * 60), now: now) == "OFFLINE \u{00B7} UPDATED 12 MIN AGO")
		#expect(WatchDecisionOptions.updatedHeader(updatedAt: now.addingTimeInterval(-20), now: now) == "UPDATED JUST NOW")
		#expect(WatchDecisionOptions.updatedHeader(updatedAt: now.addingTimeInterval(-3 * 3600), now: now) == "UPDATED 3 H AGO")
		#expect(WatchDecisionOptions.updatedHeader(updatedAt: now.addingTimeInterval(-2 * 86400), now: now) == "UPDATED 2 D AGO")
		#expect(WatchDecisionOptions.updatedHeader(updatedAt: now.addingTimeInterval(60), now: now) == "UPDATED JUST NOW")
	}

	@Test("the briefing is timed at 200 words a minute and never under a minute")
	func briefingTiming() {
		let words = Array(repeating: "word", count: 600).joined(separator: " ")
		#expect(WatchBriefingText.readSeconds(words) == 180)
		#expect(WatchBriefingText.readMinutes(words) == 3)
		#expect(WatchBriefingText.readMinutes("Hi") == 1)
		#expect(WatchBriefingText.meta(minutes: 3, headphones: true) == "3 MIN \u{00B7} AIRPODS")
		#expect(WatchBriefingText.meta(minutes: 1, headphones: false) == "1 MIN \u{00B7} WATCH SPEAKER")
	}

	@Test("playback time reads minutes and padded seconds")
	func clock() {
		#expect(WatchBriefingText.clock(72) == "1:12")
		#expect(WatchBriefingText.clock(180) == "3:00")
		#expect(WatchBriefingText.clock(5) == "0:05")
		#expect(WatchBriefingText.clock(-4) == "0:00")
	}

	@Test("the confirm title is a question")
	func confirmTitle() {
		#expect(WatchDecisionOptions.confirmTitle(for: "Approve $2,400") == "Approve $2,400?")
		#expect(WatchDecisionOptions.confirmTitle(for: "Sure?") == "Sure?")
	}
}
