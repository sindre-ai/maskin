import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

/// Answers the For You list request with a fixed body, so the test sees exactly what the card is built from.
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

@Suite("Decision draft on the For You card")
struct DecisionDraftMappingTests {
	/// One card whose decision carries `draft` (or none), shaped the way the server sends it.
	private func feed(draft: String?, drafts: String? = nil, destructive: Bool = false) -> String {
		let draftField =
			(draft.map { #","draft":\#($0)"# } ?? "") + (drafts.map { #","drafts":\#($0)"# } ?? "")
		return """
			{"items":[{
			  "notification_id":"11111111-1111-4111-8111-111111111111","source":"curated","rank":1,
			  "headline":"Send the note to Hans?","rationale":null,"created_at":"2026-10-20T10:00:00.000Z",
			  "entity_type":"object","entity_id":"task-1","session_id":null,
			  "latest_mention":{
			    "event_id":42,"actor_id":null,"created_at":"2026-10-20T10:00:00.000Z",
			    "content":"Approve the note to Hans.","attention":3,
			    "decision":{
			      "title":"Send the note to Hans?",
			      "summary":"Hans cancelled billing on 12 Oct and renewal is in 4 days.",
			      "ask":"This goes to Hans in your name, so I will not send it alone.",
			      "options":[
			        {"label":"Send as it is","recommended":true,"destructive":\(destructive),
			         "consequences":["Reaches Hans today","Cannot be recalled"]},
			        {"label":"Skip","consequences":["Nothing is sent","Renewal may lapse"]}]
			      \(draftField)}}}]}
			"""
	}

	private func card(_ json: String) async throws -> ForYouCard {
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: FeedTransport(json))
		let backend = APIForYouBackend(client: client, workspaceId: { "ws-1" })
		return try #require(try await backend.fetchFeed(workspaceId: "ws-1").first)
	}

	@Test("shows the draft the server filled in, with its label and recipient")
	func mapsDraft() async throws {
		let draft = #"{"object_id":"task-1","label":"Email to Hans","to":"Hans Jensen","body":"Hej Hans, må jeg ringe?"}"#

		let decision = try #require(try await card(feed(draft: draft)).mention?.decision)

		#expect(
			decision.draft
				== DecisionDraft(
					label: "Email to Hans", to: "Hans Jensen", body: "Hej Hans, må jeg ringe?",
					objectId: "task-1"))
	}

	@Test("falls back to the label Draft")
	func defaultLabel() async throws {
		let decision = try #require(
			try await card(feed(draft: #"{"body":"Short note."}"#)).mention?.decision)

		#expect(decision.draft?.label == "Draft")
		#expect(decision.draft?.to == nil)
	}

	@Test("shows no box for a draft the server could not fill")
	func emptyDraft() async throws {
		let unfilled = try #require(
			try await card(feed(draft: #"{"object_id":"gone"}"#)).mention?.decision)
		let blank = try #require(try await card(feed(draft: #"{"body":""}"#)).mention?.decision)

		#expect(unfilled.draft == nil)
		#expect(blank.draft == nil)
	}

	@Test("leaves a card with no draft as it was")
	func noDraft() async throws {
		let decision = try #require(try await card(feed(draft: nil)).mention?.decision)

		#expect(decision.draft == nil)
		#expect(decision.options.count == 2)
	}

	@Test("maps a stack of messages in order, keeping each id, label and recipient")
	func mapsDrafts() async throws {
		let drafts = """
			[{"id":"kenneth","label":"LinkedIn DM","to":"Kenneth Krog Madsen","body":"Hej Kenneth."},\
			 {"id":"dan","to":"Dan Højgaard Jensen","body":"Hej Dan."}]
			"""

		let decision = try #require(try await card(feed(draft: nil, drafts: drafts)).mention?.decision)

		#expect(
			decision.drafts == [
				DecisionDraft(
					id: "kenneth", label: "LinkedIn DM", to: "Kenneth Krog Madsen", body: "Hej Kenneth."),
				DecisionDraft(id: "dan", label: "Draft", to: "Dan Højgaard Jensen", body: "Hej Dan."),
			])
	}

	@Test("leaves out a message with no text and keeps the rest of the stack")
	func dropsEmptyMessages() async throws {
		let drafts = #"[{"id":"gone","object_id":"gone"},{"id":"blank","body":""},{"id":"dan","body":"Hej Dan."}]"#

		let decision = try #require(try await card(feed(draft: nil, drafts: drafts)).mention?.decision)

		#expect(decision.drafts.map(\.id) == ["dan"])
	}

	@Test("a card without a stack has an empty one")
	func noStack() async throws {
		let decision = try #require(try await card(feed(draft: nil)).mention?.decision)

		#expect(decision.drafts.isEmpty)
	}

	@Test("a card cached before stacks existed still decodes")
	func oldCacheDecodes() throws {
		let old = """
			{"title":"t","summary":"s","ask":"a",
			 "options":[{"label":"Hold","consequences":[],"recommended":true}]}
			"""
		let decision = try JSONDecoder().decode(DecisionPrompt.self, from: Data(old.utf8))

		#expect(decision.drafts.isEmpty)
		#expect(decision.draft == nil)
	}

	@Test("carries the destructive flag so Send asks for a confirm")
	func destructiveFlag() async throws {
		let flagged = try #require(
			try await card(feed(draft: nil, destructive: true)).mention?.decision)
		let plain = try #require(try await card(feed(draft: nil)).mention?.decision)

		#expect(flagged.options.first?.destructive == true)
		#expect(plain.options.first?.destructive == false)
	}
}

@Suite("Chief of Staff list on the For You feed")
struct CuratedListMappingTests {
	private func item(_ id: String?, headline: String) -> String {
		let entity = id.map { #""entity_type":"object","entity_id":"\#($0)""# }
			?? #""entity_type":null,"entity_id":null"#
		return """
			{"notification_id":"11111111-1111-4111-8111-111111111111","source":"curated","rank":1,"headline":"\(headline)",
			 "rationale":null,"created_at":"2026-10-20T10:00:00.000Z",\(entity),"session_id":null}
			"""
	}

	private func cards(_ items: [String]) async throws -> [ForYouCard] {
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!,
			transport: FeedTransport(#"{"items":[\#(items.joined(separator: ","))]}"#))
		return try await APIForYouBackend(client: client, workspaceId: { "ws-1" })
			.fetchFeed(workspaceId: "ws-1")
	}

	@Test("keeps the server's order as the rank and skips items with nothing to act on")
	func ranksByPosition() async throws {
		let result = try await cards([
			item("b", headline: "Second"), item(nil, headline: "No object"), item("a", headline: "Third"),
		])
		#expect(result.map(\.id) == ["b", "a"])
		#expect(result.map(\.rank) == [0, 2])
	}
}
