import Foundation
import Testing

@testable import MaskinCore

/// The Search tab shows the server's order and changes nothing about it. The cases are the ones the
/// server search test reads (packages/shared/fixtures/chat-search-order.json): the server answers a
/// query with the chats in the expected order, and the phone must list them exactly so, ahead of
/// whatever a re-sort by date, unread or group would do. Skipped while the file is not in the repo.
@MainActor
@Suite("Search tab order")
struct SearchServerOrderTests {
	private struct Fixture: Decodable {
		struct Chat: Decodable {
			var id: String
			var title: String
			var people: [String]
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

	/// Up from this file to the folder that holds packages/.
	nonisolated private static func fixtureURL() -> URL? {
		var url = URL(fileURLWithPath: #filePath)
		while true {
			let candidate = url.appendingPathComponent("packages/shared/fixtures/chat-search-order.json")
			if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
			let parent = url.deletingLastPathComponent()
			guard parent != url else { return nil }
			url = parent
		}
	}

	@Test("the Search tab lists chats in the order the server answered", .enabled(if: SearchServerOrderTests.fixtureURL() != nil))
	func sharedCases() async throws {
		let data = try Data(contentsOf: try #require(Self.fixtureURL()))
		let fixture = try JSONDecoder().decode(Fixture.self, from: data)
		let rows = Dictionary(
			uniqueKeysWithValues: fixture.chats.map { chat in
				(
					chat.id,
					SearchResult(
						kind: .chat, entityId: chat.id, title: chat.title, subtitle: chat.people.joined(separator: ", "),
						snippet: chat.message, updatedAt: Self.now.addingTimeInterval(-chat.minutesAgo * 60))
				)
			})
		for testCase in fixture.cases {
			let answer = testCase.expected.compactMap { rows[$0] }
			let remote = FakeSearchRemote()
			await remote.setServer { _ in answer }
			let store = makeStore(remote)
			store.setQuery(testCase.query)
			await store.settle()
			#expect(store.allResults.map(\.entityId) == testCase.expected, "query \(testCase.query)")
			#expect(store.rows.map(\.entityId) == testCase.expected, "query \(testCase.query) in the All scope")
		}
	}

	@Test("an agent that matches perfectly stays above weaker chat matches")
	func agentAboveChats() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in
			[
				agent("a1", "CCO"), chat("c1", "CCO sync", at: Date(timeIntervalSince1970: 900)),
				chat("c2", "Plan for the CCO", at: Date(timeIntervalSince1970: 100)),
			]
		}
		let store = makeStore(remote)
		store.setQuery("cco")
		await store.settle()
		#expect(store.rows.map(\.id) == ["agent:a1", "chat:c1", "chat:c2"])
	}

	@Test("an older chat the server ranks first stays above a newer one")
	func olderChatFirst() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in
			[
				chat("old", "Chat redesign", at: Date(timeIntervalSince1970: 100)),
				chat("new", "Mychat tools", at: Date(timeIntervalSince1970: 900)),
			]
		}
		let store = makeStore(remote)
		store.setQuery("chat")
		await store.settle()
		#expect(store.rows.map(\.entityId) == ["old", "new"])
	}
}
