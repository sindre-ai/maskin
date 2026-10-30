import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private final class FeedTransport: ClientTransport, @unchecked Sendable {
	let json: String
	init(_ json: String) { self.json = json }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(json))
	}
}

@Suite("Mark-read id on the For You card")
struct ForYouLatestEventIdTests {
	/// One curated item. `mention` is the whole `"latest_mention":{...},` field or nothing.
	private func feed(latestEventId: String, mention: String = "") -> String {
		"""
		{"items":[{
		  "notification_id":"11111111-1111-4111-8111-111111111111","source":"curated","rank":1,
		  "latest_event_id":\(latestEventId),
		  "headline":"Check this","rationale":null,"created_at":"2026-10-20T10:00:00.000Z",
		  "entity_type":"object","entity_id":"task-1","session_id":null\(mention)}]}
		"""
	}

	private func card(_ json: String) async throws -> ForYouCard {
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: FeedTransport(json))
		let backend = APIForYouBackend(client: client, workspaceId: { "ws-1" })
		return try #require(try await backend.fetchFeed(workspaceId: "ws-1").first)
	}

	@Test("a curated item with no source comment still carries the mark-read id")
	func fallsBackToItemId() async throws {
		let card = try await card(feed(latestEventId: "57"))

		#expect(card.mention == nil)
		#expect(card.latestEventId == 57)
	}

	@Test("the source comment wins when there is one")
	func mentionWins() async throws {
		let mention = """
			,"latest_mention":{"event_id":42,"actor_id":null,"created_at":"2026-10-20T10:00:00.000Z",
			 "content":"Look at this.","attention":3,"decision":null}
			"""

		let card = try await card(feed(latestEventId: "57", mention: mention))

		#expect(card.latestEventId == 42)
	}

	@Test("an object with no activity has nothing to mark")
	func noIdAtAll() async throws {
		let card = try await card(feed(latestEventId: "null"))

		#expect(card.latestEventId == nil)
	}
}
