import Testing

@testable import MaskinCore

@Suite("LiveDecisionQueue") struct LiveDecisionQueueTests {
	private func card(
		_ id: String, asker: String = "agent-x", options: [DecisionOption]? = nil,
		draft: DecisionDraft? = nil, ask: String = "Ship it?"
	) -> ForYouCard {
		ForYouCard(
			id: id, objectTitle: "Object \(id)",
			mention: ForYouMention(
				eventId: 1, actorId: asker, content: "ask",
				decision: DecisionPrompt(
					title: "Title \(id)", summary: "", ask: ask,
					options: options ?? [
						DecisionOption(label: "Ship", recommended: true), DecisionOption(label: "Hold"),
					], draft: draft)))
	}

	private func entry(_ card: ForYouCard, bucket: FeedBucket = .needs, record: DecisionRecord? = nil) -> FeedEntry {
		FeedEntry(card: card, bucket: bucket, record: record)
	}

	private func ids(_ cards: [ForYouCard]) -> [String] { cards.map(\.id) }

	@Test func keepsTheFeedsRankedOrderWhenNothingIsRelated() {
		let queue = LiveDecisionQueue.queue(
			from: [entry(card("a")), entry(card("b")), entry(card("c"))], thread: .init())
		#expect(ids(queue) == ["a", "b", "c"])
	}

	@Test func putsDecisionsAboutTheThreadFirst() {
		let entries = [entry(card("a")), entry(card("b", asker: "lead")), entry(card("c")), entry(card("d"))]
		let thread = LiveDecisionQueue.Thread(participantIDs: ["lead"], objectIDs: ["d"])
		#expect(ids(LiveDecisionQueue.queue(from: entries, thread: thread)) == ["b", "d", "a", "c"])
	}

	@Test func relatedMeansAMentionedObjectOrAnAskerInTheConversation() {
		let thread = LiveDecisionQueue.Thread(participantIDs: ["lead"], objectIDs: ["obj"])
		#expect(LiveDecisionQueue.isRelated(card("obj"), to: thread))
		#expect(LiveDecisionQueue.isRelated(card("z", asker: "lead"), to: thread))
		#expect(!LiveDecisionQueue.isRelated(card("z"), to: thread))
	}

	@Test func skipsCardsThatNeedMoreThanATap() {
		let draft = DecisionDraft(label: "Draft email", body: "Hi")
		let entries = [
			entry(card("ok")),
			entry(card("no-options", options: [])),
			entry(card("draft", draft: draft)),
			entry(card("only-destructive", options: [DecisionOption(label: "Delete", destructive: true)])),
			entry(ForYouCard(id: "plain", mention: ForYouMention(eventId: 2, content: "FYI"))),
		]
		#expect(ids(LiveDecisionQueue.queue(from: entries, thread: .init())) == ["ok"])
	}

	@Test func leavesOutOptionsThatAskForAConfirmation() {
		let c = card(
			"a", options: [
				DecisionOption(label: "Delete", recommended: true, destructive: true),
				DecisionOption(label: "Keep"),
			])
		#expect(LiveDecisionQueue.answerableOptions(of: c).map(\.label) == ["Keep"])
		#expect(LiveDecisionQueue.primary(of: c)?.label == "Keep")
	}

	@Test func onlyOpenDecisionsAreQueuedSoAnAnsweredOneAdvances() {
		let a = card("a")
		let answered = DecisionRecord(kind: .option("Ship"), phase: .sent)
		let queue = LiveDecisionQueue.queue(
			from: [entry(a, bucket: .done, record: answered), entry(card("b")), entry(card("fyi"), bucket: .fyi)],
			thread: .init())
		#expect(ids(queue) == ["b"])
	}

	@Test func aFailedAnswerPutsTheCardBack() {
		let a = card("a")
		let failed = DecisionRecord(kind: .option("Ship"), phase: .failed("offline"))
		#expect(ids(LiveDecisionQueue.queue(from: [entry(a, bucket: .needs, record: failed)], thread: .init())) == ["a"])
	}

	@Test func leadsWithTheRecommendedOptionAndKeepsTheRestAsAlternates() {
		let c = card(
			"a", options: [
				DecisionOption(label: "Hold"), DecisionOption(label: "Ship", recommended: true),
				DecisionOption(label: "Skip"),
			])
		#expect(LiveDecisionQueue.primary(of: c)?.label == "Ship")
		#expect(LiveDecisionQueue.alternates(of: c).map(\.label) == ["Hold", "Skip"])
	}

	@Test func leadsWithTheFirstOptionWhenNoneIsRecommended() {
		let c = card("a", options: [DecisionOption(label: "Yes"), DecisionOption(label: "No")])
		#expect(LiveDecisionQueue.primary(of: c)?.label == "Yes")
	}

	@Test func theQuestionIsTheAskElseTheHeadline() {
		#expect(LiveDecisionQueue.question(of: card("a", ask: "Ship Friday?")) == "Ship Friday?")
		#expect(LiveDecisionQueue.question(of: card("a", ask: "  ")) == "Title a")
	}

	@Test func theAgentIsToldPlainly() {
		#expect(
			LiveDecisionQueue.chosenText(label: "Ship", question: "Ship Friday?")
				== "I chose: Ship on: Ship Friday?")
	}
}
