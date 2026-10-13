import Testing

@testable import MaskinCore

@Suite("LiveCallStatus") struct LiveCallStatusTests {
	private func text(
		_ phase: LiveVoicePhase = .listening, muted: Bool = false, failure: String? = nil,
		notice: String? = nil, words: Bool = false
	) -> String {
		LiveCallStatus.text(
			phase: phase, isMuted: muted, failure: failure, notice: notice, leadName: "Relay", hasWords: words)
	}

	@Test func phasesRead() {
		#expect(text() == "Listening")
		#expect(text(words: true) == "Hearing you…")
		#expect(text(.thinking) == "Relay is working on it")
		#expect(text(.speaking).hasPrefix("Relay is speaking"))
	}

	@Test func mutedBeatsListeningButNoticesAndFailuresBeatMuted() {
		#expect(text(muted: true) == "Microphone off")
		#expect(text(muted: true, notice: "No connection") == "No connection")
		#expect(text(muted: true, failure: "Mic denied", notice: "x") == "Mic denied")
	}

	@Test func titleNamesTheKind() {
		#expect(LiveCallStatus.title(kind: .adHoc, leadName: "Relay") == "LIVE · with Relay")
		#expect(LiveCallStatus.title(kind: .dailyBriefing, leadName: "Relay") == "LIVE BRIEFING · with Relay")
	}
}
