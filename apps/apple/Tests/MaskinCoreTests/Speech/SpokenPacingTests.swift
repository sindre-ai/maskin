import Foundation
import Testing

@testable import MaskinCore

@Suite("SpokenPacing") struct SpokenPacingTests {
	@Test func twoSentencesShareABeat() {
		let beats = SpokenPacing.beats(from: "First thing. Second thing. Third thing. Fourth thing.")
		#expect(beats.map(\.text) == ["First thing. Second thing.", "Third thing. Fourth thing."])
	}

	@Test func aLongSentenceGetsABeatOfItsOwn() {
		let long = (0..<40).map { "Word\($0)" }.joined(separator: " ") + "."
		let beats = SpokenPacing.beats(from: "Short one. \(long) Another short.")
		#expect(beats.count == 3)
		#expect(beats[0].text == "Short one.")
		#expect(beats[2].text == "Another short.")
	}

	@Test func blocksNeverShareABeatAndTheFirstEndsASection() {
		let beats = SpokenPacing.beats(from: "Intro here.\n\nSecond block.")
		#expect(beats.map(\.text) == ["Intro here.", "Second block."])
		#expect(beats[0].endsSection && !beats[1].endsSection)
	}

	@Test func linesOfOneBlockAreReadAsSentences() {
		let beats = SpokenPacing.beats(from: "Billing waits on legal\nSearch waits on design\nAlerts waits on review")
		#expect(beats.map(\.text) == ["Billing waits on legal. Search waits on design.", "Alerts waits on review."])
	}

	@Test func emptyTextHasNoBeats() {
		#expect(SpokenPacing.beats(from: "  \n\n ").isEmpty)
	}

	@Test func paceSettings() {
		#expect(LiveCallPace.relaxed.breakLength == 1.8 && LiveCallPace.relaxed.usesCheckIns)
		#expect(LiveCallPace.normal.breakLength == 0.8 && !LiveCallPace.normal.usesCheckIns)
		#expect(!LiveCallPace.quick.isPaced)
		#expect(LiveCallPace.relaxed.speechRate < LiveCallPace.normal.speechRate)
	}

	@Test func paceIsRememberedAndDefaultsToRelaxed() {
		let defaults = UserDefaults(suiteName: "pace-\(UUID().uuidString)")!
		#expect(LiveCallPace.stored(defaults) == .relaxed)
		LiveCallPace.quick.store(defaults)
		#expect(LiveCallPace.stored(defaults) == .quick)
	}

	@Test func checkInSpeaksInTheUsersLanguage() {
		#expect(SpokenPacing.checkInLine(languageCode: "da").hasPrefix("Skal jeg"))
		#expect(SpokenPacing.checkInLine(languageCode: "en").hasPrefix("Want me"))
	}
}

@Suite("SpokenReaction") struct SpokenReactionTests {
	@Test(arguments: ["yes", "Yeah", "ok", "okay", "mm-hm", "mhm", "go on", "Go on.", "continue", "next", "right", "sure", "keep going", "ja", "okay", "fortsæt", "næste", "Ja, fortsæt"])
	func acknowledgementsContinue(_ text: String) {
		#expect(SpokenReaction.classify(text) == .continue)
	}

	@Test(arguments: ["wait", "Stop", "hold on", "hold on a second", "vent", "stop lige", "wait, what about billing"])
	func holdPhrasesHold(_ text: String) {
		#expect(SpokenReaction.classify(text) == .hold)
	}

	@Test(arguments: ["what about billing", "yes but who owns it", "no", "can you repeat that", "hvad med fakturering"])
	func everythingElseIsATurn(_ text: String) {
		#expect(SpokenReaction.classify(text) == .turn)
	}

	@Test func whatFollowsAHoldPhraseIsTheTurn() {
		#expect(SpokenReaction.afterHold("wait what about billing") == "what about billing")
		#expect(SpokenReaction.afterHold("Hold on a second, who owns it?") == "who owns it?")
		#expect(SpokenReaction.afterHold("stop lige") == "")
	}
}
