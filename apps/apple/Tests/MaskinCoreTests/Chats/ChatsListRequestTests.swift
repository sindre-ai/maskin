import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private final class PathTransport: ClientTransport, @unchecked Sendable {
	private let lock = NSLock()
	private var _paths: [String] = []
	var paths: [String] { lock.withLock { _paths } }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		lock.withLock { _paths.append(request.path ?? "") }
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(#"{"conversations":[],"has_more":false}"#))
	}
}

@Suite("Conversation list request")
struct ChatsListRequestTests {
	private func request(archived: Bool) async throws -> String {
		let transport = PathTransport()
		let client = Client(serverURL: URL(string: "http://localhost:3000")!, transport: transport)
		_ = try await APIChatsSource(client: client, workspaceID: "ws-1")
			.list(archived: archived, limit: 30, offset: 0)
		return try #require(transport.paths.first)
	}

	// The server reads `?archived=false` as true (z.coerce.boolean), which returned the archived list.
	@Test("omits archived for the active list")
	func activeOmitsArchived() async throws {
		#expect(try await !request(archived: false).contains("archived"))
	}

	@Test("sends archived=true for the archived list")
	func archivedSendsTrue() async throws {
		#expect(try await request(archived: true).contains("archived=true"))
	}
}
