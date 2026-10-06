import Foundation
import Testing

@testable import MaskinCore

/// A list API whose responses are computed when the request ARRIVES and delivered when released,
/// like a slow network: a response can be stale by the time it is applied.
private actor GatedListAPI: ConversationsAPI {
	var rows: [ConversationSummary]
	var hold = false
	var waiters: [CheckedContinuation<Void, Never>] = []
	var arrived = 0
	var filters: [String] = []

	init(_ rows: [ConversationSummary]) { self.rows = rows }

	func set(_ rows: [ConversationSummary]) { self.rows = rows }
	func holdResponses() { hold = true }
	func release() {
		hold = false
		for waiter in waiters { waiter.resume() }
		waiters = []
	}

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws
		-> ConversationPage
	{
		filters.append("pinned=\(pinnedOnly) unread=\(unreadOnly)")
		let snapshot = rows
		arrived += 1
		if hold { await withCheckedContinuation { waiters.append($0) } }
		return ConversationPage(conversations: snapshot, hasMore: false)
	}

	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String)
		async throws -> ConversationSummary
	{ chatConvo("new") }

	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool
	) async throws {}

	func actors() async throws -> [ChatActor] { [] }
}

@Suite("ConversationsStore filters and read races")
@MainActor
struct ConversationsFilterTests {
	@Test("the unread and pinned filters ask the server, and only with true")
	func filtersGoToServer() async {
		let api = FakeListAPI([chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		store.filter = .unread
		#expect(await eventually { await api.listFilters.last == "pinned=false unread=true" })
		store.filter = .pinned
		#expect(await eventually { await api.listFilters.last == "pinned=true unread=false" })
		store.filter = .all
		#expect(await eventually { await api.listFilters.last == "pinned=false unread=false" })
	}

	@Test("a list response computed before a thread was read can't bring its unread badge back")
	func staleListDoesNotResurrectUnread() async {
		let api = GatedListAPI([chatConvo("a", unread: 2)])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.conversation(id: "a")?.unreadCount == 2)

		await api.holdResponses()
		let inFlight = Task { await store.refresh() }
		#expect(await eventually { await api.arrived == 2 })

		// The thread marks the conversation read while that response is still on the wire.
		await api.set([chatConvo("a", unread: 0)])
		await store.markRead("a", serverAlreadyKnows: true)
		await api.release()
		await inFlight.value

		#expect(store.conversation(id: "a")?.unreadCount == 0)
		#expect(store.totalUnread == 0)
	}

	@Test("recent collaborators follow the list order, each once")
	func recents() async {
		let api = FakeListAPI([
			chatConvo("a", participants: [chatMe, chatSam]), chatConvo("b", participants: [chatMe, chatRelay, chatSam]),
		])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		#expect(store.recentCollaboratorIDs == ["me", "sam", "relay"])
	}

	@Test("pinning and archiving a thread rolls back when the server refuses")
	func pinArchiveRollback() async {
		let api = FakeListAPI([chatConvo("a")])
		let store = ConversationsStore(api: api, events: nil)
		await store.refresh()
		await api.setFailState(true)
		await store.setPinned("a", true)
		#expect(store.conversation(id: "a")?.pinned == false)
		await store.setArchived("a", true)
		#expect(store.conversation(id: "a") != nil, "archive rolled back")
		await api.setFailState(false)
		await store.setPinned("a", true)
		#expect(store.conversation(id: "a")?.pinned == true)
		await store.setArchived("a", true)
		#expect(store.conversation(id: "a") == nil)
	}
}
