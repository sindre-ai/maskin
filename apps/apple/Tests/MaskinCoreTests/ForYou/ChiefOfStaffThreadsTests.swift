import Foundation
import Testing

@testable import MaskinCore

private let chief = ChatParticipant(id: "cos", name: "Chief of Staff", kind: .agent)

private actor CoSAPI: ConversationsAPI {
	var items: [ConversationSummary]
	let actorList: [ChatActor]
	var created: [(title: String, ids: [String], first: String?)] = []

	init(items: [ConversationSummary] = [], actors: [ChatActor] = [ChatActor(participant: chief, isSystem: true)]) {
		self.items = items
		actorList = actors
	}

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws
		-> ConversationPage
	{
		ConversationPage(conversations: items, hasMore: false)
	}

	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String)
		async throws -> ConversationSummary
	{
		created.append((title, participantIDs, initialMessage))
		return chatConvo("new", title: title, participants: [chatMe, chief])
	}

	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool
	) async throws {}

	func actors() async throws -> [ChatActor] { actorList }
}

private let card = ForYouCard(
	id: "o1", objectTitle: "Onboarding redesign", objectType: "bet",
	mention: ForYouMention(
		eventId: 1, content: "ask",
		decision: DecisionPrompt(
			title: "Ship it?", summary: "s", ask: "a",
			options: [DecisionOption(label: "7-day window", recommended: true), DecisionOption(label: "Hold")])))

@Suite("ChiefOfStaffThreads")
@MainActor
struct ChiefOfStaffThreadsTests {
	@Test("a first reply creates an 'About' thread with the Chief of Staff and names the object")
	func createsThread() async throws {
		let api = CoSAPI()
		let store = ConversationsStore(api: api, events: nil)
		let outcome = try await ChiefOfStaffThreads.open(about: card, conversations: store)
		guard case .created(let c) = outcome else { Issue.record("expected created"); return }
		#expect(c.title == "About: Onboarding redesign")
		let made = await api.created
		#expect(made.count == 1)
		#expect(made[0].ids == ["cos"])
		#expect(made[0].first == nil)
	}

	@Test("a later reply about the same object reuses the thread instead of creating another")
	func reusesThread() async throws {
		let existing = chatConvo("c9", title: "About: Onboarding redesign", participants: [chatMe, chief])
		let api = CoSAPI(items: [existing])
		let store = ConversationsStore(api: api, events: nil)
		let outcome = try await ChiefOfStaffThreads.open(about: card, conversations: store)
		#expect(outcome == .existing(existing))
		let made = await api.created
		#expect(made.isEmpty)
	}

	@Test("an archived thread is not reused")
	func skipsArchived() async throws {
		var archived = chatConvo("c9", title: "About: Onboarding redesign", participants: [chatMe, chief])
		archived.archived = true
		let api = CoSAPI(items: [archived])
		let store = ConversationsStore(api: api, events: nil)
		let outcome = try await ChiefOfStaffThreads.open(about: card, conversations: store)
		guard case .created = outcome else { Issue.record("expected created"); return }
	}

	@Test("a workspace without a Chief of Staff throws instead of picking another agent")
	func noChief() async {
		let api = CoSAPI(actors: [ChatActor(participant: chatRelay)])
		let store = ConversationsStore(api: api, events: nil)
		await #expect(throws: ChiefOfStaffThreads.NoChiefOfStaff.self) {
			_ = try await ChiefOfStaffThreads.open(about: card, conversations: store)
		}
	}

	@Test("the first message carries a decision card's text and a link to its object")
	func firstMessageWithOptions() {
		let text = ChiefOfStaffThreads.firstMessage("Why?", about: card, workspaceID: "w")
		#expect(text.contains("Card: Ship it?"))
		#expect(text.contains("- 7-day window (recommended)\n- Hold"))
		#expect(text.contains("[Onboarding redesign](https://maskin.io/w/objects/o1)"))
		#expect(text.hasSuffix("\n\nWhy?"))
	}

	@Test("the first message for a card without options carries its headline and body, and no link without a workspace")
	func firstMessageWithoutOptions() {
		let plain = ForYouCard(
			id: "o2", objectTitle: "Pricing page",
			mention: ForYouMention(eventId: 2, content: "Copy is ready. Please look at the second block."))
		let text = ChiefOfStaffThreads.firstMessage("Looks fine?", about: plain)
		#expect(text == "Re: Pricing page\n\nCard: Copy is ready.\nPlease look at the second block.\n\nLooks fine?")
		#expect(!text.contains("Options:"))
	}

	@Test("quick questions are three; a decision gets the mockup's three")
	func chips() {
		let chips = ForYouQuickQuestions.chips(for: card)
		#expect(chips.count == 3)
		#expect(chips == ["Explain it simply", "What if I wait?", "Who\u{2019}s involved?"])
		let thread = ForYouQuickQuestions.chips(for: ForYouCard(id: "x"))
		#expect(thread.count == 3)
	}
}

@Suite("ChiefOfStaffDesk")
@MainActor
struct ChiefOfStaffDeskTests {
	private func desk(_ api: CoSAPI) -> ChiefOfStaffDesk {
		ChiefOfStaffDesk(conversations: ConversationsStore(api: api, events: nil), uploader: nil, selfActorID: "me")
	}

	@Test("submitting opens the thread with the message pending, names the object on a new thread, and clears the composer")
	func submits() async {
		let desk = desk(CoSAPI())
		desk.composer(for: card).text = "Why not send all?"
		await desk.submit(card: card)
		#expect(desk.presented?.conversationID == "new")
		#expect(desk.presented?.pending?.text == """
			Re: Onboarding redesign

			Card: Ship it?
			s
			a
			Options:
			- 7-day window (recommended)
			- Hold

			[Onboarding redesign](https://maskin.io/w/objects/o1)

			Why not send all?
			""")
		#expect(desk.composer(for: card).text.isEmpty)
	}

	@Test("a chip sends its question as the reader's message")
	func chip() async {
		let existing = chatConvo("c9", title: "About: Onboarding redesign", participants: [chatMe, chief])
		let desk = desk(CoSAPI(items: [existing]))
		await desk.ask("What if I wait?", card: card)
		#expect(desk.presented?.conversationID == "c9")
		#expect(desk.presented?.pending?.text == "What if I wait?")
	}

	@Test("sending never touches the card's decision: no option is chosen by a message")
	func notAChoice() async {
		let desk = desk(CoSAPI())
		desk.composer(for: card).text = "hello"
		await desk.submit(card: card)
		// The desk has no reference to the decision service at all; the card is only the topic.
		#expect(desk.presented?.card == card)
	}

	@Test("opening a thread without a message presents it with nothing pending")
	func opensEmpty() async {
		let existing = chatConvo("c9", title: "About: Onboarding redesign", participants: [chatMe, chief])
		let desk = desk(CoSAPI(items: [existing]))
		await desk.openThread(card: card)
		#expect(desk.presented?.conversationID == "c9")
		#expect(desk.presented?.pending == nil)
	}

	@Test("a failure gives the words back and says why")
	func failure() async {
		let desk = desk(CoSAPI(actors: []))
		desk.composer(for: card).text = "hello"
		await desk.submit(card: card)
		#expect(desk.presented == nil)
		#expect(desk.composer(for: card).text == "hello")
		#expect(desk.notice != nil)
	}

	@Test("the pending message is handed over exactly once")
	func pendingOnce() async {
		let desk = desk(CoSAPI())
		await desk.ask("hi", card: card)
		#expect(desk.takePending() != nil)
		#expect(desk.takePending() == nil)
	}
}

@Suite("ChiefOfStaffThreads watch thread")
@MainActor
struct ChiefOfStaffWatchThreadTests {
	@Test("the first question creates a 'Watch' thread with the Chief of Staff")
	func createsWatchThread() async throws {
		let api = CoSAPI()
		let store = ConversationsStore(api: api, events: nil)
		let outcome = try await ChiefOfStaffThreads.openWatchThread(conversations: store)
		guard case .created(let c) = outcome else { Issue.record("expected created"); return }
		#expect(c.title == "Watch")
		#expect(await api.created.map(\.ids) == [["cos"]])
	}

	@Test("later questions reuse it, and an 'About' thread is never mistaken for it")
	func reusesWatchThread() async throws {
		let about = chatConvo("c1", title: "About: Onboarding redesign", participants: [chatMe, chief])
		let watch = chatConvo("c2", title: "Watch", participants: [chatMe, chief])
		let api = CoSAPI(items: [about, watch])
		let store = ConversationsStore(api: api, events: nil)
		let outcome = try await ChiefOfStaffThreads.openWatchThread(conversations: store)
		#expect(outcome == .existing(watch))
		#expect(await api.created.isEmpty)
	}

	@Test("a workspace without a Chief of Staff throws")
	func noChief() async {
		let api = CoSAPI(actors: [ChatActor(participant: chatRelay)])
		let store = ConversationsStore(api: api, events: nil)
		await #expect(throws: ChiefOfStaffThreads.NoChiefOfStaff.self) {
			_ = try await ChiefOfStaffThreads.openWatchThread(conversations: store)
		}
	}
}
