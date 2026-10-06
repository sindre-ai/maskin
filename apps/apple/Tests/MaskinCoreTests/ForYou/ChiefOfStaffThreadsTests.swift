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

	@Test("quick questions are three, and a decision's first names its recommended option")
	func chips() {
		let chips = ForYouQuickQuestions.chips(for: card)
		#expect(chips.count == 3)
		#expect(chips[0] == "Why 7-day window?")
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
		#expect(desk.presented?.pending?.text == "Re: Onboarding redesign\n\nWhy not send all?")
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
