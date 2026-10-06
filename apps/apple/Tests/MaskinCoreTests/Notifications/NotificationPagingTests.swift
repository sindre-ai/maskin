import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinCore

/// A server with `total` notifications, served ascending in pages like the real list route.
/// Records the pages requested and which were in flight together.
private final class PagedTransport: ClientTransport, @unchecked Sendable {
	private let total: Int
	private let lock = NSLock()
	private var requested: [Int] = []
	private var inFlight = 0
	private(set) var maxInFlight = 0
	var pages: [Int] { lock.withLock { requested } }

	init(total: Int) { self.total = total }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		let query = (request.path ?? "").split(separator: "?", maxSplits: 1).last.map(String.init) ?? ""
		var offset = 0
		var limit = 50
		for pair in query.split(separator: "&") {
			let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
			if kv.count == 2, kv[0] == "offset" { offset = Int(kv[1]) ?? 0 }
			if kv.count == 2, kv[0] == "limit" { limit = Int(kv[1]) ?? 50 }
		}
		lock.withLock {
			requested.append(offset / max(limit, 1))
			inFlight += 1
			maxInFlight = max(maxInFlight, inFlight)
		}
		// Hold the response briefly so concurrent requests overlap in the recorder.
		try? await Task.sleep(for: .milliseconds(20))
		lock.withLock { inFlight -= 1 }

		let upper = min(offset + limit, total)
		let rows = offset < upper ? (offset..<upper).map(Self.row) : []
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody("[" + rows.joined(separator: ",") + "]"))
	}

	/// Valid per the response schema; the title carries the global index so order is checkable.
	private static func row(_ index: Int) -> String {
		let id = UUID().uuidString
		return """
			{"id":"\(id)","workspaceId":"\(UUID().uuidString)","type":"alert","title":"n\(index)","content":null,\
			"metadata":null,"sourceActorId":"\(UUID().uuidString)","targetActorId":null,"objectId":null,\
			"sessionId":null,"status":"pending","resolvedAt":null,\
			"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}
			"""
	}
}

private func source(_ transport: PagedTransport) -> APINotificationsSource {
	APINotificationsSource(
		client: Client(serverURL: URL(string: "http://localhost:3000")!, transport: transport)
	) { "ws" }
}

@Suite("Notification inbox paging")
struct NotificationPagingTests {
	@Test("an inbox that fits one page is a single request")
	func onePage() async throws {
		let transport = PagedTransport(total: 40)
		let rows = try await source(transport).list()
		#expect(rows.count == 40)
		#expect(transport.pages == [0])
	}

	@Test("a big inbox is read in parallel waves, in order, with nothing missing or doubled")
	func bigInbox() async throws {
		let transport = PagedTransport(total: 250)  // pages 0, 1, 2(partial)
		let rows = try await source(transport).list()
		#expect(rows.map(\.title) == (0..<250).map { "n\($0)" })
		#expect(transport.pages.sorted().prefix(3) == [0, 1, 2])
		// Pages 1... were requested together, not one after another (it used to be strictly serial).
		#expect(transport.maxInFlight > 1)
	}

	@Test("an inbox of exactly two full pages still ends cleanly")
	func exactMultiple() async throws {
		let transport = PagedTransport(total: 200)
		let rows = try await source(transport).list()
		#expect(rows.count == 200)
		#expect(Set(rows.map(\.id)).count == 200)
	}

	@Test("the walk is bounded: a huge inbox stops at the page cap")
	func bounded() async throws {
		let transport = PagedTransport(total: 5000)
		let rows = try await source(transport).list()
		#expect(rows.count == 1000)  // 10 pages of 100
		#expect(transport.pages.count == 10)
	}
}
