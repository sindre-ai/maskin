import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private final class RecordingTransport: ClientTransport, @unchecked Sendable {
	private let lock = NSLock()
	private var _calls: [(path: String, key: String?)] = []
	var calls: [(path: String, key: String?)] { lock.withLock { _calls } }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		lock.withLock { _calls.append((request.path ?? "", request.headerFields[IdempotencyMiddleware.header])) }
		var response = HTTPResponse(status: .created)
		response.headerFields[.contentType] = "application/json"
		let json =
			(request.path ?? "").hasSuffix("/members")
			? #"{"added":true}"#
			: #"""
			{"id":"7a1c3b9e-0f5d-4c2a-9d38-1b2c3d4e5f60","type":"agent","name":"Scout","email":null,
			"description":null,"system_prompt":null,"tools":null,"memory":null,"llm_provider":null,
			"llm_config":null,"isSystem":false,"agentState":"idle","agentStateUpdatedAt":null,
			"createdAt":null,"updatedAt":null,"api_key":"ank_test"}
			"""#
		return (response, HTTPBody(json))
	}
}

@Suite("Agent create keys")
struct APIAgentsCreateKeysTests {
	@Test("the actor and the member add carry different Idempotency-Keys")
	func twoWritesTwoKeys() async throws {
		let transport = RecordingTransport()
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: transport,
			middlewares: [IdempotencyMiddleware()])
		let source = APIAgentsSource(client: client, workspaceID: "ws-1")

		_ = try await source.create(
			draft: AgentDraft(name: "Scout", description: "", systemPrompt: ""), idempotencyKey: "k1")

		let calls = transport.calls
		#expect(calls.count == 2)
		#expect(calls.first?.key == "k1")
		#expect(calls.last?.key == "k1-member")
	}
}
