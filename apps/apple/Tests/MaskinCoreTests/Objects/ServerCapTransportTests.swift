import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinCore

/// Records every request the real generated client sends and rejects what the server would:
/// `limit` above 100 is a 400, like the zod `.max(100)` on every list route.
private final class CapTransport: ClientTransport, @unchecked Sendable {
	struct Seen { var path: String; var query: [String: String] }
	private let lock = NSLock()
	private var _seen: [Seen] = []
	var seen: [Seen] { lock.withLock { _seen } }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		let parts = (request.path ?? "").split(separator: "?", maxSplits: 1).map(String.init)
		var query: [String: String] = [:]
		if parts.count == 2 {
			for pair in parts[1].split(separator: "&") {
				let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
				query[kv[0]] = kv.count == 2 ? (kv[1].removingPercentEncoding ?? kv[1]) : ""
			}
		}
		lock.withLock { _seen.append(Seen(path: parts[0], query: query)) }
		if let limit = query["limit"].flatMap(Int.init), limit > 100 {
			return (HTTPResponse(status: .badRequest), HTTPBody("{}"))
		}
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody("[]"))
	}
}

private func makeClient(_ transport: CapTransport) -> Client {
	Client(serverURL: URL(string: "http://localhost:3000")!, transport: transport)
}

@Suite("Real adapters stay under server caps")
struct ServerCapTransportTests {
	@Test("APIObjectsRemote.actors pages at the cap, never limit 500")
	func objectActors() async throws {
		let transport = CapTransport()
		let remote = APIObjectsRemote(client: makeClient(transport)) { MaskinCredentials(apiKey: "ank_x", workspaceId: UUID().uuidString) }
		_ = try await remote.actors()
		let limits = transport.seen.filter { $0.path.hasSuffix("/actors") }.compactMap { $0.query["limit"].flatMap(Int.init) }
		#expect(!limits.isEmpty)
		#expect(limits.allSatisfy { $0 <= 100 })
	}

	@Test("APIObjectsRemote.list clamps an oversized limit")
	func objectList() async throws {
		let transport = CapTransport()
		let remote = APIObjectsRemote(client: makeClient(transport)) { MaskinCredentials(apiKey: "ank_x", workspaceId: UUID().uuidString) }
		_ = try await remote.list(ObjectsQuery(limit: 500))
		#expect(transport.seen.compactMap { $0.query["limit"].flatMap(Int.init) }.allSatisfy { $0 <= 100 })
	}

	@Test("APINotificationsSource.actors chunks 250 ids into requests of at most 100")
	func notificationActors() async throws {
		let transport = CapTransport()
		let source = APINotificationsSource(client: makeClient(transport)) { "ws" }
		let ids = (0..<250).map { _ in UUID().uuidString }
		_ = try await source.actors(ids: ids)
		let requests = transport.seen.filter { $0.path.hasSuffix("/actors") }
		#expect(requests.count == 3)
		#expect(requests.allSatisfy { Int($0.query["limit"] ?? "") ?? 999 <= 100 })
		let sent = requests.flatMap { ($0.query["ids"] ?? "").split(separator: ",") }
		#expect(sent.count == 250)
		#expect(requests.allSatisfy { ($0.query["ids"] ?? "").split(separator: ",").count <= 100 })
	}
}
