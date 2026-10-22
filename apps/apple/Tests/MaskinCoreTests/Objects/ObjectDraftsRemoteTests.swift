import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinCore

/// Answers `GET /api/objects/{id}` the way the server does for a draft, and 404 for anything else.
private final class DraftTransport: ClientTransport, @unchecked Sendable {
	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		let path = request.path ?? ""
		guard path.contains("/api/objects/") else { return (HTTPResponse(status: .notFound), HTTPBody("{}")) }
		if path.hasSuffix("/gone") { return (HTTPResponse(status: .notFound), HTTPBody(#"{"error":{"code":"NOT_FOUND","message":"x"}}"#)) }
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		let withPreview = !path.hasSuffix("/plain")
		let preview = """
			"preview": {"kind": "email", "label": "Email", "provider": "gmail",
			"recipients": [{"role": "to", "name": "Torben", "address": "t@example.dk"}],
			"subject": "Hej", "details": [{"label": "Account", "value": "sam@x.dk"}],
			"body": "Hello Torben", "maxLength": null, "missing": [], "warnings": ["Check the tone."],
			"content_hash": "abc123", "delivery": {"state": "approved", "at": null}}
			"""
		let json = """
			{"id": "11111111-2222-3333-4444-555555555555", "workspaceId": "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa",
			"type": "task", "title": "Email to Torben", "content": "Hello Torben", "status": "draft", "metadata": {},
			"driver": null, "activeSessionId": null, "createdBy": "7d1f0c52-0e0a-4f43-9c1e-bbbbbbbbbbbb",
			"createdAt": "2026-10-20T10:00:00.000Z", "updatedAt": "2026-10-20T10:00:00.000Z",
			"is_subscribed": false, "unread_count": 0, "subscriber_count": 0, "is_starred_by_me": false,
			\(withPreview ? preview : #""preview": null"#)}
			"""
		return (response, HTTPBody(json))
	}
}

@Suite("Draft lookups and approvals through the real client")
struct ObjectDraftsRemoteTests {
	private let credentials: MaskinCredentialsProvider = {
		MaskinCredentials(apiKey: "ank_x", workspaceId: "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa")
	}

	private func remote(raw: Bool = false) -> APIObjectsRemote {
		let client = Client(serverURL: URL(string: "http://localhost:3000")!, transport: DraftTransport())
		return raw
			? APIObjectsRemote(
				client: client, credentials: credentials, baseURL: URL(string: "http://localhost:3000")!,
				clientSource: "ios")
			: APIObjectsRemote(client: client, credentials: credentials)
	}

	@Test("a draft comes back with its workspace and the whole preview")
	func draftDetail() async throws {
		let detail = try await remote().detail(objectId: "11111111-2222-3333-4444-555555555555")
		#expect(detail.workspaceId == "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa")
		#expect(detail.object.title == "Email to Torben")
		let preview = try #require(detail.preview)
		#expect(preview.kind == "email")
		#expect(preview.recipients == [.init(role: "to", name: "Torben", address: "t@example.dk")])
		#expect(preview.subject == "Hej")
		#expect(preview.details == [.init(label: "Account", value: "sam@x.dk")])
		#expect(preview.warnings == ["Check the tone."])
		#expect(preview.contentHash == "abc123")
		#expect(preview.delivery == .approved)
	}

	@Test("an object that is not a draft has no preview")
	func plainDetail() async throws {
		let detail = try await remote().detail(objectId: "plain")
		#expect(detail.preview == nil)
		#expect(detail.object.content == "Hello Torben")
	}

	@Test("a missing object is the not-found error")
	func missing() async {
		await #expect(throws: ObjectsError.self) { _ = try await remote().detail(objectId: "gone") }
	}

	@Test("the approval request names the object, carries the hash and an idempotency key, and the person's credentials")
	func approvalRequest() async throws {
		let api = remote(raw: true)
		let transport = try #require(api.rawTransportForTesting)
		let request = await api.makeApprovalRequest(
			objectId: "obj-1", contentHash: "abc123", idempotencyKey: "key-1", transport: transport)
		#expect(request.url?.path == "/api/objects/obj-1/approval")
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_x")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa")
		#expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "key-1")
		#expect(request.value(forHTTPHeaderField: "X-Client-Source") == "ios")
		let body = try #require(request.httpBody)
		#expect(try JSONDecoder().decode([String: String].self, from: body) == ["content_hash": "abc123"])
	}

	@Test("without a transport the card says approving isn't available")
	func noTransport() async {
		await #expect(throws: ObjectApprovalError.other("Approving isn't available here.")) {
			_ = try await remote().approve(objectId: "x", contentHash: "h", idempotencyKey: "k")
		}
	}
}
