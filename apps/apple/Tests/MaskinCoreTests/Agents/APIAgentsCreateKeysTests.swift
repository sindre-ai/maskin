import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private final class RecordingTransport: ClientTransport, @unchecked Sendable {
	private let lock = NSLock()
	private var _requests: [(path: String, body: String)] = []
	var requests: [(path: String, body: String)] { lock.withLock { _requests } }
	let status: HTTPResponse.Status

	init(status: HTTPResponse.Status = .created) { self.status = status }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var text = ""
		if let body { text = try await String(collecting: body, upTo: 1 << 16) }
		lock.withLock { _requests.append((request.path ?? "", text)) }
		var response = HTTPResponse(status: status)
		response.headerFields[.contentType] = "application/json"
		let json =
			status == .created
			? #"""
			{"id":"7a1c3b9e-0f5d-4c2a-9d38-1b2c3d4e5f60","type":"agent","name":"Scout","email":null,
			"description":null,"system_prompt":null,"tools":null,"memory":null,"llm_provider":null,
			"llm_config":null,"isSystem":false,"agentState":"idle","agentStateUpdatedAt":null,
			"createdAt":null,"updatedAt":null,"api_key":"ank_test"}
			"""#
			: #"{"error":{"code":"CONFLICT","message":"exists"}}"#
		return (response, HTTPBody(json))
	}
}

@Suite("Agent create")
struct APIAgentsCreateTests {
	private func source(_ transport: RecordingTransport) -> APIAgentsSource {
		APIAgentsSource(
			client: Client(
				serverURL: URL(string: "http://localhost:3000")!, transport: transport,
				middlewares: [IdempotencyMiddleware()]),
			workspaceID: "ws-1")
	}

	private let draft = AgentDraft(name: "Scout", description: "", systemPrompt: "")

	@Test("makes the agent a member in the same single request, with the key as its id")
	func oneRequest() async throws {
		let transport = RecordingTransport()
		let key = UUID().uuidString
		_ = try await source(transport).create(draft: draft, idempotencyKey: key)

		#expect(transport.requests.count == 1)
		#expect(transport.requests[0].path == "/api/actors")
		let sent = try #require(
			JSONSerialization.jsonObject(with: Data(transport.requests[0].body.utf8)) as? [String: Any])
		#expect(sent["workspace_id"] as? String == "ws-1")
		#expect(sent["id"] as? String == key.lowercased())
	}

	@Test("a retry that finds its own agent already exists is a success")
	func retryAfterLostResponse() async throws {
		let transport = RecordingTransport(status: .conflict)
		let key = UUID().uuidString
		let made = try await source(transport).create(draft: draft, idempotencyKey: key)
		#expect(made.id == key.lowercased())
	}

	@Test("a conflict without an id of our own stays an error")
	func conflictWithoutID() async {
		let transport = RecordingTransport(status: .conflict)
		await #expect(throws: AgentsError.self) {
			try await source(transport).create(draft: draft, idempotencyKey: "not-a-uuid")
		}
	}
}
