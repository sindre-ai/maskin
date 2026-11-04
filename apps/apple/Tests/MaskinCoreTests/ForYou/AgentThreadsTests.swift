import Foundation
import Testing

@testable import MaskinCore

private let chief = ChatParticipant(id: "cos", name: "Chief of Staff", kind: .agent)
private let seo = ChatParticipant(id: "seo", name: "SEO Researcher", kind: .agent)

/// A fake remote for the conversations list and create: records what was created.
private actor AgentAPI: ConversationsAPI {
	var items: [ConversationSummary]
	let actorList: [ChatActor]
	var created: [(title: String, ids: [String])] = []

	init(items: [ConversationSummary] = []) {
		self.items = items
		actorList = [
			ChatActor(participant: chief, isSystem: true), ChatActor(participant: seo),
			ChatActor(participant: chatSam),
		]
	}

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws
		-> ConversationPage
	{
		ConversationPage(conversations: items, hasMore: false)
	}

	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String)
		async throws -> ConversationSummary
	{
		created.append((title, participantIDs))
		let others = actorList.map(\.participant).filter { participantIDs.contains($0.id) }
		return chatConvo("new", title: title, participants: [chatMe] + others)
	}

	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool
	) async throws {}

	func actors() async throws -> [ChatActor] { actorList }
}

@Suite("AgentThreads")
@MainActor
struct AgentThreadsTests {
	private let title = AgentThreads.title(about: "Onboarding redesign")

	@Test("the first message to an agent creates a chat with exactly that agent, named for the object")
	func createsWithThatAgent() async throws {
		let api = AgentAPI()
		let store = ConversationsStore(api: api, events: nil)
		let opened = try await AgentThreads.open(withAgent: "seo", titled: title, conversations: store)
		guard case .created(let made) = opened.outcome else { Issue.record("expected created"); return }
		#expect(made.title == "About: Onboarding redesign")
		#expect(await api.created.map(\.ids) == [["seo"]])
		#expect(opened.recipient == AgentThreads.Recipient(id: "seo", name: "SEO Researcher", isChiefOfStaff: false))
	}

	@Test("a later message about the same object reuses that agent's chat")
	func reuses() async throws {
		let existing = chatConvo("c1", title: title, participants: [chatMe, seo])
		let api = AgentAPI(items: [existing])
		let store = ConversationsStore(api: api, events: nil)
		let opened = try await AgentThreads.open(withAgent: "seo", titled: title, conversations: store)
		#expect(opened.outcome == .existing(existing))
		#expect(await api.created.isEmpty)
	}

	@Test("a different agent gets its own chat; the Chief of Staff's chat is not taken over")
	func differentAgentGetsItsOwnChat() async throws {
		let cosChat = chatConvo("c1", title: title, participants: [chatMe, chief])
		let api = AgentAPI(items: [cosChat])
		let store = ConversationsStore(api: api, events: nil)
		let opened = try await AgentThreads.open(withAgent: "seo", titled: title, conversations: store)
		guard case .created = opened.outcome else { Issue.record("expected created"); return }
		#expect(await api.created.map(\.ids) == [["seo"]])
	}

	@Test("an agent tagged into the Chief of Staff's chat does not own it either")
	func taggedAgentDoesNotTakeOver() async throws {
		let shared = chatConvo("c1", title: title, participants: [chatMe, chief, seo])
		let store = ConversationsStore(api: AgentAPI(items: [shared]), events: nil)
		let opened = try await AgentThreads.open(withAgent: "seo", titled: title, conversations: store)
		guard case .created = opened.outcome else { Issue.record("expected created"); return }
	}

	@Test("the Chief of Staff keeps finding its existing 'About' chats, even with others invited")
	func chiefOfStaffKeepsItsLegacyRule() async throws {
		let legacy = chatConvo("c1", title: title, participants: [chatMe, chief, seo])
		let store = ConversationsStore(api: AgentAPI(items: [legacy]), events: nil)
		let opened = try await AgentThreads.open(withAgent: "cos", titled: title, conversations: store)
		#expect(opened.outcome == .existing(legacy))
		#expect(opened.recipient.isChiefOfStaff)
	}

	@Test("an archived chat is not reused, and people tagged in are invited to a new one")
	func archivedAndInvites() async throws {
		var archived = chatConvo("c1", title: title, participants: [chatMe, seo])
		archived.archived = true
		let api = AgentAPI(items: [archived])
		let store = ConversationsStore(api: api, events: nil)
		let opened = try await AgentThreads.open(
			withAgent: "seo", titled: title, alsoInvite: ["sam", "seo"], conversations: store)
		guard case .created = opened.outcome else { Issue.record("expected created"); return }
		#expect(await api.created.map(\.ids) == [["seo", "sam"]])
	}

	@Test("an id that is not an agent here throws instead of messaging someone else")
	func unknownAgentThrows() async {
		let store = ConversationsStore(api: AgentAPI(), events: nil)
		await #expect(throws: AgentThreads.AgentNotFound.self) {
			_ = try await AgentThreads.open(withAgent: "nobody", titled: title, conversations: store)
		}
		await #expect(throws: AgentThreads.AgentNotFound.self) {
			_ = try await AgentThreads.open(withAgent: "sam", titled: title, conversations: store)
		}
	}

	@Test("the first message tags the agent so it is woken in a chat of any size")
	func taggingAddsTheAgentOnce() {
		#expect(AgentThreads.tagging("seo", in: nil).mentions == ["seo"])
		let tagged = ChatSendMetadata(mentions: ["sam", "seo"])
		#expect(AgentThreads.tagging("seo", in: tagged).mentions == ["sam", "seo"])
	}
}

@Suite("ChiefOfStaffDesk recipients")
@MainActor
struct DeskRecipientTests {
	private let card = ForYouCard(id: "o1", objectTitle: "Onboarding redesign", objectType: "bet")

	@Test("a card with an agent opens a chat with that agent, names it, and tags it")
	func messagesTheCardsAgent() async {
		let api = AgentAPI()
		let desk = ChiefOfStaffDesk(
			conversations: ConversationsStore(api: api, events: nil), uploader: nil, selfActorID: "me")
		await desk.ask("Why?", card: card, agent: ForYouActor(id: "seo", name: "SEO Researcher", isAgent: true))
		#expect(await api.created.map(\.ids) == [["seo"]])
		#expect(desk.presented?.recipient.name == "SEO Researcher")
		#expect(desk.presented?.pending?.metadata?.mentions == ["seo"])
	}

	@Test("a card with no agent goes to the Chief of Staff and says so")
	func fallsBackToTheChiefOfStaff() async {
		let api = AgentAPI()
		let desk = ChiefOfStaffDesk(
			conversations: ConversationsStore(api: api, events: nil), uploader: nil, selfActorID: "me")
		await desk.ask("Why?", card: card)
		#expect(await api.created.map(\.ids) == [["cos"]])
		#expect(desk.presented?.recipient == .chiefOfStaff)
	}

	@Test("an agent that is gone is reported, not swapped for another")
	func goneAgentIsReported() async {
		let desk = ChiefOfStaffDesk(
			conversations: ConversationsStore(api: AgentAPI(), events: nil), uploader: nil, selfActorID: "me")
		desk.composer(for: card).text = "hello"
		await desk.submit(card: card, agent: ForYouActor(id: "gone", name: "Ghost", isAgent: true))
		#expect(desk.presented == nil)
		#expect(desk.composer(for: card).text == "hello")
		#expect(desk.notice == "Ghost is no longer in this workspace.")
	}
}
