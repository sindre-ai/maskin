import Testing

@testable import MaskinCore

@Suite("HoldReason")
struct HoldReasonTests {
	@Test func recognisesHoldOptions() {
		#expect(HoldReason.isHold("Hold"))
		#expect(HoldReason.isHold("  hold for now"))
		#expect(!HoldReason.isHold("Withhold payment"))
		#expect(!HoldReason.isHold("Approve"))
	}

	@Test func emptyReasonIsSkipped() {
		#expect(HoldReason.normalized("  \n") == nil)
		#expect(HoldReason.normalized(" Later ") == "Later")
		#expect(HoldReason.note(for: nil) == "Held \u{00B7} your reason: none given")
		#expect(HoldReason.note(for: "I need the numbers first") == "Held \u{00B7} your reason: I need the numbers first")
	}

	@Test func subtitleNamesWhoWaits() {
		#expect(HoldReason.subtitle(agent: "Forge").hasPrefix("Forge waits rather than guessing."))
		#expect(HoldReason.subtitle(agent: nil).hasPrefix("The agent waits"))
	}
}
