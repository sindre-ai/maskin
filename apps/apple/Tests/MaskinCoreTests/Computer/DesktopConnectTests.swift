import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

/// Answers every request from memory with a new ticket each time, and records what was sent.
private final class ConnectProtocol: URLProtocol, @unchecked Sendable {
	struct Seen { var url: String; var method: String; var headers: [String: String] }
	nonisolated(unsafe) static var seen: [Seen] = []
	nonisolated(unsafe) static var status = 200
	nonisolated(unsafe) static var fail = false
	nonisolated(unsafe) static var body: String?
	static let lock = NSLock()

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		let r = request
		let (status, fail, body, count) = Self.lock.withLock {
			Self.seen.append(
				Seen(url: r.url?.absoluteString ?? "", method: r.httpMethod ?? "", headers: r.allHTTPHeaderFields ?? [:]))
			return (Self.status, Self.fail, Self.body, Self.seen.count)
		}
		if fail {
			client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
			return
		}
		let json = body ?? #"{"ticket":"ticket-\#(count)","path":"/api/desktop/stream","password":"pw"}"#
		let response = HTTPURLResponse(
			url: r.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: Data(json.utf8))
		client?.urlProtocolDidFinishLoading(self)
	}
	override func stopLoading() {}
}

@Suite("APIDesktopConnect", .serialized)
struct DesktopConnectTests {
	private func connector(
		status: Int = 200, fail: Bool = false, body: String? = nil, credentials: MaskinCredentials? = MaskinCredentials(apiKey: "ank_secret", workspaceId: "ws-1")
	) -> APIDesktopConnect {
		ConnectProtocol.lock.withLock {
			ConnectProtocol.seen = []
			ConnectProtocol.status = status
			ConnectProtocol.fail = fail
			ConnectProtocol.body = body
		}
		let config = URLSessionConfiguration.ephemeral
		config.protocolClasses = [ConnectProtocol.self]
		return APIDesktopConnect(
			baseURL: URL(string: "https://maskin.io")!, clientSource: "ios", credentials: { credentials },
			session: URLSession(configuration: config))
	}
	private var seen: [ConnectProtocol.Seen] { ConnectProtocol.lock.withLock { ConnectProtocol.seen } }

	@Test("the request names the agent and carries the key and workspace")
	func requestShape() async throws {
		let c = connector()
		_ = try await c.connect(agentID: "agent-1")
		let request = try #require(seen.first)
		#expect(request.url == "https://maskin.io/api/desktop/connect?agent_id=agent-1")
		#expect(request.method == "POST")
		#expect(request.headers["Authorization"] == "Bearer ank_secret")
		#expect(request.headers["X-Workspace-Id"] == "ws-1")
		#expect(request.headers["X-Client-Source"] == "ios")
		// A replayed answer would be a spent ticket.
		#expect(request.headers["Idempotency-Key"] == nil)
	}

	@Test("every connect asks the server again and gets a different ticket")
	func freshTicketEachTime() async throws {
		let c = connector()
		let first = try await c.connect(agentID: "agent-1")
		let second = try await c.connect(agentID: "agent-1")
		#expect(seen.count == 2)
		#expect(first.ticket != second.ticket)
	}

	@Test("no agent id means no request")
	func missingAgent() async {
		let c = connector()
		await #expect(throws: DesktopConnectError.missingAgent) { try await c.connect(agentID: nil) }
		await #expect(throws: DesktopConnectError.missingAgent) { try await c.connect(agentID: "") }
		#expect(seen.isEmpty)
	}

	@Test("signed out sends nothing")
	func signedOut() async {
		let c = connector(credentials: nil)
		await #expect(throws: DesktopConnectError.signedOut) { try await c.connect(agentID: "agent-1") }
		#expect(seen.isEmpty)
	}

	@Test("server answers map to what the screen says", arguments: [
		(400, DesktopConnectError.missingAgent), (401, .signedOut), (403, .notAllowed), (404, .unavailable),
		(503, .noCapacity), (500, .server(status: 500)),
	])
	func errorMapping(status: Int, expected: DesktopConnectError) async {
		let c = connector(status: status)
		await #expect(throws: expected) { try await c.connect(agentID: "agent-1") }
	}

	@Test("a dropped connection is a network error")
	func network() async {
		let c = connector(fail: true)
		await #expect(throws: DesktopConnectError.network) { try await c.connect(agentID: "agent-1") }
	}

	@Test("an answer without a ticket is a server error")
	func emptyAnswer() async {
		let c = connector(body: #"{"ticket":"","path":"/api/desktop/stream","password":"pw"}"#)
		await #expect(throws: DesktopConnectError.server(status: 200)) { try await c.connect(agentID: "agent-1") }
	}

	@Test("the stream address uses wss for https, ws for plain http, and carries the ticket")
	func streamURL() throws {
		let ticket = DesktopTicket(ticket: "abc.def", path: "/api/desktop/stream", password: "pw")
		#expect(ticket.streamURL(base: URL(string: "https://maskin.io")!)?.absoluteString == "wss://maskin.io/api/desktop/stream?ticket=abc.def")
		#expect(ticket.streamURL(base: URL(string: "http://localhost:3000")!)?.absoluteString == "ws://localhost:3000/api/desktop/stream?ticket=abc.def")
	}

	@Test("the ticket, address and password never appear when printed")
	func redacted() {
		let ticket = DesktopTicket(ticket: "secret-ticket", path: "/api/desktop/stream", password: "secret-pw")
		let stream = ComputerStream(url: URL(string: "wss://maskin.io/x?ticket=secret-ticket")!, password: "secret-pw")
		for text in ["\(ticket)", "\(String(reflecting: ticket))", "\(stream)", "\(String(reflecting: stream))"] {
			#expect(!text.contains("secret"))
		}
	}
}
