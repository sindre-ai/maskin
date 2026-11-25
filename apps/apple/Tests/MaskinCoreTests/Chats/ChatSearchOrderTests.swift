import Foundation
import Testing

@testable import MaskinCore

/// The order of a chat search, read from the file the server test reads too
/// (packages/shared/fixtures/chat-search-order.json), so the phone and the server cannot drift apart.
/// Archived chats are left out of the expected order: the server lists them among the matches, the
/// phone lists archived matches apart.
@Suite("ChatSearchOrder")
struct ChatSearchOrderTests {
	private struct Fixture: Decodable {
		struct Chat: Decodable {
			var id: String
			var title: String
			var people: [String]
			var archived: Bool
			var unread: Bool
			var minutesAgo: Double
			var message: String
		}
		struct Case: Decodable {
			var query: String
			var expected: [String]
		}
		var chats: [Chat]
		var cases: [Case]
	}

	private static let now = Date(timeIntervalSince1970: 1_790_000_000)
	private static let me = ChatParticipant(id: "me", name: "Me", kind: .human)

	private static func load() throws -> Fixture {
		// Up from this file to the folder that holds packages/.
		var url = URL(fileURLWithPath: #filePath)
		while !FileManager.default.fileExists(atPath: url.appendingPathComponent("packages/shared/fixtures").path) {
			let parent = url.deletingLastPathComponent()
			guard parent != url else { throw CocoaError(.fileNoSuchFile) }
			url = parent
		}
		let data = try Data(contentsOf: url.appendingPathComponent("packages/shared/fixtures/chat-search-order.json"))
		return try JSONDecoder().decode(Fixture.self, from: data)
	}

	private static func summary(_ chat: Fixture.Chat) -> ConversationSummary {
		let date = now.addingTimeInterval(-chat.minutesAgo * 60)
		ConversationSummary(
			id: chat.id, title: chat.title, lastMessageAt: date, createdAt: date, archived: chat.archived,
			unreadCount: chat.unread ? 1 : 0, snippet: chat.message,
			participants: [me] + chat.people.map { ChatParticipant(id: $0, name: $0, kind: .human) })
	}

	@Test("the Chats list search orders chats as the shared cases say")
	func chatsList() throws {
		let fixture = try Self.load()
		let archivedIDs = Set(fixture.chats.filter(\.archived).map(\.id))
		for testCase in fixture.cases {
			let layout = TeamLayout.build(
				TeamLayout.Input(
					conversations: fixture.chats.filter { !$0.archived }.map(Self.summary), archived: fixture.chats.filter(\.archived).map(Self.summary),
					query: testCase.query, currentActorID: "me", now: Self.now, calendar: Calendar(identifier: .gregorian)))
			#expect(
				layout.sections.flatMap { $0.rows.map(\.id) } == testCase.expected.filter { !archivedIDs.contains($0) },
				"query \(testCase.query)")
			#expect(
				layout.archivedMatches.map(\.id) == testCase.expected.filter { archivedIDs.contains($0) },
				"archived matches of \(testCase.query)")
		}
	}

	@Test("the Search tab orders chats as the shared cases say")
	func searchTab() throws {
		let fixture = try Self.load()
		let archivedIDs = Set(fixture.chats.filter(\.archived).map(\.id))
		let results = fixture.chats.filter { !$0.archived }.map { chat in
			SearchResult(
				kind: .chat, entityId: chat.id, title: chat.title, subtitle: (["Me"] + chat.people).joined(separator: ", "),
				snippet: chat.message, updatedAt: Self.now.addingTimeInterval(-chat.minutesAgo * 60),
				participantIds: ["me"] + chat.people, isUnread: chat.unread,
				hasPlaceholderTitle: ConversationSummary.isPlaceholder(chat.title))
		}
		for testCase in fixture.cases {
			let found = SearchStore.filter(results, testCase.query)
			let ordered = SearchRanking.ordered(found, query: testCase.query)
			#expect(
				ordered.map(\.entityId) == testCase.expected.filter { !archivedIDs.contains($0) },
				"query \(testCase.query)")
		}
	}
}
