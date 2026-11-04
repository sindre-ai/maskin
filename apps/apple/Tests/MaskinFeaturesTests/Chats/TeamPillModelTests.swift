import MaskinCore
import Testing

@testable import MaskinFeatures

private actor EmptyListAPI: ConversationsAPI {
	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws -> ConversationPage {
		ConversationPage(conversations: [], hasMore: false)
	}
	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String) async throws -> ConversationSummary {
		throw ChatsError("offline")
	}
	func updateState(conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool) async throws {}
	func actors() async throws -> [ChatActor] { [] }
	func latestMessageID(conversationID: String) async throws -> Int? { nil }
}

@MainActor
@Suite("TeamPillModel")
struct TeamPillModelTests {
	private func attachedModel(chips: Bool = true) -> TeamPillModel {
		let store = ConversationsStore(api: EmptyListAPI(), events: nil)
		store.displayOptions.showsFilterChips = chips
		let model = TeamPillModel()
		model.attach(store: store, onThreads: {})
		return model
	}

	@Test("the pill shows with the list on top and hides while a chat or the Threads screen covers it")
	func hidesWhenCovered() {
		let model = attachedModel()
		#expect(model.isShown)
		model.isCovered = true
		#expect(!model.isShown)
		model.isCovered = false
		#expect(model.isShown)
	}

	@Test("covered state does not turn the pill on when Quick filters is off")
	func staysOffWithoutChips() {
		let model = attachedModel(chips: false)
		#expect(!model.isShown)
		model.isCovered = false
		#expect(!model.isShown)
	}
}
