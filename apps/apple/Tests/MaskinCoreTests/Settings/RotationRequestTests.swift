import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private final class HeaderTransport: ClientTransport, @unchecked Sendable {
	private let lock = NSLock()
	private var _headers: [HTTPFields] = []
	var headers: [HTTPFields] { lock.withLock { _headers } }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		lock.withLock { _headers.append(request.headerFields) }
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(#"{"api_key":"ank_rotated"}"#))
	}
}

@Suite("Key rotation request")
struct RotationRequestTests {
	@Test("sends no Idempotency-Key even inside an outer keyed scope")
	func noKeyHeader() async throws {
		let transport = HeaderTransport()
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: transport,
			middlewares: [IdempotencyMiddleware()])
		let source = APISettingsSource(client: client, workspaceID: "ws-1")
		let key = try await IdempotencyKey.$current.withValue("outer-key") {
			try await source.regenerate(actorId: "actor-1")
		}
		#expect(key.reveal() == "ank_rotated")
		#expect(transport.headers.count == 1)
		#expect(transport.headers[0][IdempotencyMiddleware.header] == nil)
	}
}
