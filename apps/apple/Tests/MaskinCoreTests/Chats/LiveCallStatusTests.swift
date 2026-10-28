import Testing

@testable import MaskinCore

@Suite("LiveCallStatus") struct LiveCallStatusTests {
	private func text(
		_ phase: LiveVoicePhase = .listening, muted: Bool = false, failure: String? = nil,
		notice: String? = nil, words: Bool = false, yourTurn: Bool = false
	) -> String {
		LiveCallStatus.text(
			phase: phase, isMuted: muted, failure: failure, notice: notice, leadName: "Relay", hasWords: words,
			yourTurn: yourTurn)
	}

	@Test func phasesRead() {
		#expect(text() == "Listening…")
		#expect(text(words: true) == "Hearing you…")
		#expect(text(.thinking) == "Working on it…")
		#expect(text(.speaking) == "Relay is speaking…")
		#expect(text(.speaking, yourTurn: true) == "Your turn…")
		#expect(
			LiveCallStatus.text(
				phase: .speaking, isMuted: false, failure: nil, notice: nil, leadName: "Relay", hasWords: false,
				interruptible: true) == "Speaking. Tap to interrupt")
	}

	@Test func mutedBeatsListeningButNoticesAndFailuresBeatMuted() {
		#expect(text(muted: true) == "Microphone off")
		#expect(text(muted: true, notice: "No connection") == "No connection")
		#expect(text(muted: true, failure: "Mic denied", notice: "x") == "Mic denied")
	}

	@Test func mutedNeverSaysListening() {
		for phase in [LiveVoicePhase.listening, .thinking, .speaking] where phase == .listening {
			#expect(!text(phase, muted: true, words: true).contains("Listening"))
		}
	}

	@Test func titleNamesTheKind() {
		#expect(LiveCallStatus.title(kind: .adHoc, leadName: "Relay") == "LIVE · with Relay")
		#expect(LiveCallStatus.title(kind: .dailyBriefing, leadName: "Relay") == "LIVE BRIEFING · with Relay")
	}
}
