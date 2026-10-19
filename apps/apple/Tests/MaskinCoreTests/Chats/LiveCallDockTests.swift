import Testing

@testable import MaskinCore

@Suite("LiveCallDock") struct LiveCallDockTests {
	@Test func startsOpenWithSpeakerAndNoCaptions() {
		let state = LiveCallDockState()
		#expect(!state.isCollapsed)
		#expect(!state.captionsOn)
		#expect(state.speakerOn)
		#expect(state.speakerLabel == "Speaker")
	}

	@Test func togglesFlipAndFlipBack() {
		var state = LiveCallDockState()
		state.toggleCollapsed()
		state.toggleCaptions()
		state.toggleSpeaker()
		#expect(state.isCollapsed)
		#expect(state.captionsOn)
		#expect(!state.speakerOn)
		#expect(state.speakerLabel == "Earpiece")
		state.toggleCollapsed()
		#expect(!state.isCollapsed)
	}

	@Test func micLabelNamesMuted() {
		#expect(LiveCallDockState.micLabel(isMuted: false) == "Mic")
		#expect(LiveCallDockState.micLabel(isMuted: true) == "Muted")
	}

	private func caption(
		_ phase: LiveVoicePhase = .listening, speaking: String? = nil, mine: String = "", last: String? = nil
	) -> String {
		LiveCallCaption.text(
			phase: phase, agentSpeaking: speaking, yourWords: mine, lastAgentLine: last, leadName: "Relay")
	}

	@Test func captionFollowsWhoIsTalking() {
		#expect(caption(.speaking, speaking: "Two things need you.") == "Two things need you.")
		#expect(caption(.listening, speaking: "old", mine: "yes do it", last: "old") == "yes do it")
		#expect(caption(.listening, last: "Two things need you.") == "Two things need you.")
	}

	@Test func captionExplainsItselfWhenNothingWasSaid() {
		#expect(caption() == "Captions appear here when Relay speaks.")
		#expect(caption(.speaking, speaking: "  ") == "Captions appear here when Relay speaks.")
	}

	private func card(_ id: String, options: [DecisionOption], ask: String = "Ship it?") -> ForYouCard {
		ForYouCard(
			id: id, objectTitle: "Pricing", objectType: "bet",
			mention: ForYouMention(
				eventId: 1, content: "x",
				decision: DecisionPrompt(title: "Title", summary: "s", ask: ask, options: options)))
	}

	@Test func decisionTakesTheRecommendedAnswerAsMain() {
		let entries = [
			FeedEntry(
				card: card(
					"a",
					options: [
						DecisionOption(label: "Hold"), DecisionOption(label: "Ship", recommended: true),
						DecisionOption(label: "Drop"), DecisionOption(label: "Later"),
					]),
				bucket: .needs)
		]
		let decision = LiveCallDecision.current(in: entries)
		#expect(decision?.main.label == "Ship")
		#expect(decision?.alternatives.map(\.label) == ["Hold", "Drop"])
		#expect(decision?.ask == "Ship it?")
		#expect(decision?.label == "DECIDING NOW · 1 OPEN")
	}

	@Test func decisionSkipsHandledPlainAndDestructive() {
		let entries = [
			FeedEntry(card: card("done", options: [DecisionOption(label: "Ship")]), bucket: .done),
			FeedEntry(
				card: ForYouCard(id: "p", mention: ForYouMention(eventId: 2, content: "FYI")), bucket: .needs),
			FeedEntry(
				card: card("risky", options: [DecisionOption(label: "Send to all", destructive: true)]),
				bucket: .needs),
			FeedEntry(
				card: card(
					"ok", options: [DecisionOption(label: "Wipe", destructive: true), DecisionOption(label: "Keep")]),
				bucket: .needs),
		]
		let decision = LiveCallDecision.current(in: entries)
		#expect(decision?.card.id == "ok")
		#expect(decision?.main.label == "Keep")
		#expect(decision?.alternatives.isEmpty == true)
		#expect(decision?.openCount == 2)
	}

	@Test func noDecisionWhenNothingIsOpen() {
		#expect(LiveCallDecision.current(in: []) == nil)
	}

	@Test func initialsAreTwoLetters() {
		#expect(LiveCallInitials.text("Chief of Staff") == "CO")
		#expect(LiveCallInitials.text("Relay") == "RE")
		#expect(LiveCallInitials.text("Sindre Aasen") == "SA")
	}
}
