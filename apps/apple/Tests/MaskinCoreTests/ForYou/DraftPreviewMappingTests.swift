import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private final class PreviewFeedTransport: ClientTransport, @unchecked Sendable {
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

@Suite("Draft preview and file on the For You card")
struct DraftPreviewMappingTests {
	private static let preview = """
		{"kind":"email","label":"Email","recipients":[
		   {"role":"to","name":"Hans Jensen","address":"hans@example.com"},
		   {"role":"cc","address":"ops@example.com"}],
		 "subject":"Renewal","details":[{"label":"Posting as","value":"Magnus"}],
		 "body":"Hej Hans","missing":["subject"],"warnings":["Goes to an external address"],
		 "content_hash":"abc123","delivery":{"state":"sent","at":"2026-10-20T10:00:00.000Z"}}
		"""

	private func feed(draft: String?, drafts: String? = nil) -> String {
		let field = (draft.map { #","draft":\#($0)"# } ?? "") + (drafts.map { #","drafts":\#($0)"# } ?? "")
		return """
			{"items":[{
			  "notification_id":"11111111-1111-4111-8111-111111111111","source":"curated","rank":1,
			  "headline":"h","rationale":null,"created_at":"2026-10-20T10:00:00.000Z",
			  "entity_type":"object","entity_id":"task-1","session_id":null,
			  "latest_mention":{"event_id":42,"actor_id":null,"created_at":"2026-10-20T10:00:00.000Z",
			    "content":"c","attention":3,
			    "decision":{"title":"t","summary":"s","ask":"a",
			      "options":[{"label":"Send","recommended":true,"consequences":[]}]\(field)}}}]}
			"""
	}

	private func decision(_ json: String) async throws -> DecisionPrompt {
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: PreviewFeedTransport(json))
		let backend = APIForYouBackend(client: client, workspaceId: { "ws-1" })
		let card = try #require(try await backend.fetchFeed(workspaceId: "ws-1").first)
		return try #require(card.mention?.decision)
	}

	@Test("maps recipients, subject, details, notes, hash and delivery")
	func mapsPreview() async throws {
		let draft = #"{"object_id":"o1","label":"Email to Hans","body":"Hej Hans","preview":\#(Self.preview)}"#
		let mapped = try #require(try await decision(feed(draft: draft)).draft)
		let preview = try #require(mapped.preview)

		#expect(mapped.objectId == "o1")
		#expect(preview.kind == "email")
		#expect(preview.subject == "Renewal")
		#expect(preview.recipients.map(\.role) == ["to", "cc"])
		#expect(preview.details == [.init(label: "Posting as", value: "Magnus")])
		#expect(preview.missing == ["subject"])
		#expect(preview.warnings == ["Goes to an external address"])
		#expect(preview.contentHash == "abc123")
		#expect(preview.delivery == .sent)
		#expect(!preview.canApprove)
	}

	@Test("keeps a draft that is a file even though it has no text")
	func keepsFileDraft() async throws {
		let file = #"{"file_id":"f1","label":"Page","file":{"id":"f1","name":"plan.html","mime_type":"text/html","size_bytes":2048}}"#
		let mapped = try #require(try await decision(feed(draft: file)).draft)

		#expect(mapped.body.isEmpty)
		#expect(mapped.file == FileReference(id: "f1", name: "plan.html", mimeType: "text/html", sizeBytes: 2048))
		#expect(mapped.file?.kindLabel == "HTML page")
	}

	@Test("keeps file drafts in a stack and still drops one with neither text nor file")
	func stackMix() async throws {
		let drafts = """
			[{"id":"a","file":{"id":"f1","name":"p.png","mime_type":"image/png","size_bytes":10}},\
			 {"id":"b","object_id":"gone"},\
			 {"id":"c","body":"Hej","preview":\(Self.preview)}]
			"""
		let decision = try await decision(feed(draft: nil, drafts: drafts))

		#expect(decision.drafts.map(\.id) == ["a", "c"])
		#expect(decision.drafts[0].file?.isImage == true)
		#expect(decision.drafts[1].preview?.delivery == .sent)
	}

	@Test("a draft without a preview or file maps exactly as before")
	func plainDraft() async throws {
		let mapped = try #require(
			try await decision(feed(draft: #"{"label":"Email","to":"Hans","body":"Hej"}"#)).draft)

		#expect(mapped == DecisionDraft(label: "Email", to: "Hans", body: "Hej"))
		#expect(mapped.preview == nil && mapped.file == nil)
	}

	@Test("meta rows read To, Cc, Subject, then details, and skip empty values")
	func metaRows() {
		let preview = ObjectPreview(
			kind: "email", label: "Email",
			recipients: [
				.init(role: "to", name: "Hans", address: "h@x.com"), .init(role: "to", address: "a@x.com"),
				.init(role: "cc", address: "c@x.com"),
			],
			subject: " Renewal ", details: [.init(label: "Channel", value: ""), .init(label: "Posting as", value: "Me")],
			body: "b", contentHash: "h")

		#expect(
			preview.metaRows.map { "\($0.label)=\($0.value)" }
				== ["To=Hans <h@x.com>, a@x.com", "Cc=c@x.com", "Subject=Renewal", "Posting as=Me"])
	}

	@Test("file kinds are named for people")
	func kindLabels() {
		func kind(_ name: String, _ mime: String) -> String {
			FileReference(id: "1", name: name, mimeType: mime, sizeBytes: 1).kindLabel
		}
		#expect(kind("a.png", "image/png") == "Image")
		#expect(kind("a.md", "text/markdown") == "Markdown")
		#expect(kind("a.md", "application/octet-stream") == "Markdown")
		#expect(kind("a.txt", "text/plain") == "Text")
		#expect(kind("a.zip", "application/zip") == "File")
	}
}
