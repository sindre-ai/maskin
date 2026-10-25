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
		#expect(WatchDecisionOptions.visibleRows == 3)
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

	@Test("paragraphs split on blank lines and drop empties")
	func paragraphs() {
		#expect(WatchBriefingText.paragraphs("One\n\n\nTwo\n\n") == ["One", "Two"])
	}

	@Test("the footer counts what waits behind the decision")
	func remaining() {
		#expect(WatchDecisionOptions.remainingLabel(2) == "2 MORE \u{00B7} SCROLL")
		#expect(WatchDecisionOptions.remainingLabel(0) == "LAST ONE")
	}

	@Test("the confirm title is a question")
	func confirmTitle() {
		#expect(WatchDecisionOptions.confirmTitle(for: "Approve $2,400") == "Approve $2,400?")
		#expect(WatchDecisionOptions.confirmTitle(for: "Sure?") == "Sure?")
	}
}
