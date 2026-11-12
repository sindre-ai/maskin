import Foundation
import Testing

@testable import MaskinCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

private func message(
	_ id: Int, _ text: String, at seconds: TimeInterval, actor: String = "sam", threadRoot: Int? = nil,
	alsoInChannel: Bool = false
) -> ChatMessage {
	ChatMessage.confirmed(
		serverID: id, conversationID: "room", actorID: actor, actorName: actor.capitalized, author: .human,
		content: text, createdAt: at(seconds), threadRootID: threadRoot, alsoInChannel: alsoInChannel)
}

private func comment(_ id: String, _ text: String, at seconds: TimeInterval, eventId: Int) -> TimelineItem {
	TimelineItem(id: id, kind: .comment(text), actorId: "sam", date: at(seconds), eventId: eventId)
}

private func event(_ id: String, _ text: String, at seconds: TimeInterval, eventId: Int) -> TimelineItem {
	TimelineItem(id: id, kind: .activity(text), actorId: "forge", date: at(seconds), eventId: eventId)
}

/// A fake remote that only knows which room a flow has.
private actor RoomAPI: ConversationsAPI {
	let liveRoom: ConversationSummary?
	let archivedRoom: ConversationSummary?
	private(set) var asked: [Bool] = []

	init(live: ConversationSummary? = nil, archived: ConversationSummary? = nil) {
		liveRoom = live
		archivedRoom = archived
	}

	func flowConversation(flowID: String, archived: Bool) async throws -> ConversationSummary? {
		asked.append(archived)
		return archived ? archivedRoom : liveRoom
	}

	func list(archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, limit: Int, offset: Int) async throws
		-> ConversationPage
	{
		ConversationPage(conversations: [], hasMore: false)
	}

	func create(title: String, participantIDs: [String], initialMessage: String?, idempotencyKey: String)
		async throws -> ConversationSummary
	{
		ConversationSummary(id: "new", title: title)
	}

	func updateState(
		conversationID: String, pinned: Bool?, archived: Bool?, lastReadMessageID: Int?, markUnread: Bool
	) async throws {}

	func actors() async throws -> [ChatActor] { [] }
}

@Suite("Flow room")
struct FlowRoomTests {
	@Test("messages, old comments and events come out in one list, oldest first")
	func mergesByTime() {
		let merged = FlowRoom.merged(
			timeline: [
				event("e2", "moved status to active", at: 40, eventId: 2),
				comment("c1", "Kicking this off", at: 10, eventId: 1),
			],
			messages: [message(7, "Looks good", at: 30), message(5, "Hello", at: 20)])
		#expect(merged.map(\.id) == ["c1", "room-m5", "room-m7", "e2"])
	}

	@Test("nothing anywhere merges to nothing")
	func empty() {
		#expect(FlowRoom.merged(timeline: [], messages: []).isEmpty)
	}

	@Test("equal times keep the order they came in")
	func stableTies() {
		let merged = FlowRoom.merged(
			timeline: [event("e1", "started", at: 10, eventId: 1)],
			messages: [message(1, "First", at: 10), message(2, "Second", at: 10)])
		#expect(merged.map(\.id) == ["e1", "room-m1", "room-m2"])
	}

	@Test("a message with no date goes last")
	func undatedLast() {
		let undated = ChatMessage(
			id: "local-x", conversationID: "room", actorID: "me", actorName: "Me", author: .human,
			content: "Sending", status: .sending)
		let merged = FlowRoom.merged(
			timeline: [event("e1", "started", at: 10, eventId: 1)], messages: [undated])
		#expect(merged.map(\.id) == ["e1", "room-local-x"])
	}

	@Test("thread replies stay out of the room unless sent to the channel too")
	func threadReplies() {
		let merged = FlowRoom.merged(
			timeline: [],
			messages: [
				message(1, "Root", at: 10),
				message(2, "Only in thread", at: 20, threadRoot: 1),
				message(3, "Also in room", at: 30, threadRoot: 1, alsoInChannel: true),
			])
		#expect(merged.map(\.id) == ["room-m1", "room-m3"])
	}

	@Test("a message from the viewer is a comment from them, with its words and time")
	func viewerMessage() {
		let item = FlowRoom.item(for: message(9, "On it", at: 50, actor: "me"))
		#expect(item.kind == .comment("On it"))
		#expect(item.actorId == "me")
		#expect(item.date == at(50))
		#expect(item.delivery == .sent)
		#expect(item.eventId == nil)
	}

	@Test("a queued message reads as sending and a refused one as not sent")
	func delivery() {
		func pending(_ status: ChatMessage.Status) -> ChatMessage {
			ChatMessage(
				id: "local-k", conversationID: "room", actorID: "me", actorName: "Me", author: .human,
				content: "Hi", createdAt: at(1), status: status)
		}
		#expect(FlowRoom.item(for: pending(.sending)).delivery == .sending)
		#expect(FlowRoom.item(for: pending(.waiting("Offline"))).delivery == .sending)
		#expect(FlowRoom.item(for: pending(.failed("No"))).delivery == .failed)
	}

	@Test("a system line in the chat is a quiet line")
	func systemLine() {
		let line = ChatMessage.confirmed(
			serverID: 3, conversationID: "room", actorID: "forge", actorName: "Forge", author: .agent,
			kind: "system", content: "Forge joined", createdAt: at(5))
		#expect(FlowRoom.item(for: line).kind == .activity("Forge joined"))
	}

	@Test("a room item leads back to its chat message, anything else does not")
	func messageIDRoundTrip() {
		let item = FlowRoom.item(for: message(12, "Hi", at: 1))
		#expect(FlowRoom.messageID(fromItemID: item.id) == "m12")
		#expect(FlowRoom.messageID(fromItemID: "e2") == nil)
	}

	@Test("the room says what the web says")
	func copy() {
		#expect(FlowRoom.placeholder == "Message the room")
		#expect(FlowRoom.emptyTitle == "No messages yet")
		#expect(FlowRoom.emptyBody == "Messages and events from this flow show up here.")
	}

	@Test("the live chat is found without asking for archived ones")
	func findsLive() async throws {
		let api = RoomAPI(live: ConversationSummary(id: "live", title: "Flow"))
		let found = try await FlowRoom.find(flowID: "f1", api: api)
		#expect(found?.id == "live")
		#expect(await api.asked == [false])
	}

	@Test("an archived chat is found when there is no live one")
	func findsArchived() async throws {
		let api = RoomAPI(archived: ConversationSummary(id: "old", title: "Flow", archived: true))
		let found = try await FlowRoom.find(flowID: "f1", api: api)
		#expect(found?.id == "old")
		#expect(await api.asked == [false, true])
	}

	@Test("a flow with no chat has no room")
	func findsNothing() async throws {
		let api = RoomAPI()
		#expect(try await FlowRoom.find(flowID: "f1", api: api) == nil)
	}
}
