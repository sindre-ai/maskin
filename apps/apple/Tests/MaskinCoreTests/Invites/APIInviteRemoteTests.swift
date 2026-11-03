import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

/// Answers every request from memory and records what was sent, so the real client (middleware
/// included) is exercised end to end without a server.
private final class RecordingProtocol: URLProtocol, @unchecked Sendable {
	struct Seen { var path: String; var method: String; var authorization: String?; var workspace: String? }
	nonisolated(unsafe) static var seen: [Seen] = []
	nonisolated(unsafe) static var status = 200
	nonisolated(unsafe) static var json = "{}"
	static let lock = NSLock()

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		let r = request
		Self.lock.withLock {
			Self.seen.append(
				Seen(
					path: (r.url?.path ?? "") + (r.url?.query.map { "?" + $0 } ?? ""),
					method: r.httpMethod ?? "", authorization: r.value(forHTTPHeaderField: "Authorization"),
					workspace: r.value(forHTTPHeaderField: "X-Workspace-Id")))
		}
		let response = HTTPURLResponse(
			url: r.url!, statusCode: Self.status, httpVersion: nil,
			headerFields: ["Content-Type": "application/json"])!
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: Data(Self.json.utf8))
		client?.urlProtocolDidFinishLoading(self)
	}
	override func stopLoading() {}
}

private let previewJSON = """
	{"status":"pending","workspaceId":"11111111-1111-1111-1111-111111111111","workspaceName":"Mesh Firm",
	"inviterName":"Grace","inviteEmail":"ada@example.com","role":"admin","expiresAt":"2030-01-02T03:04:05.678Z"}
	"""

@Suite("APIInviteRemote", .serialized)
struct APIInviteRemoteTests {
	private func remote(status: Int, json: String) -> APIInviteRemote {
		RecordingProtocol.lock.withLock {
			RecordingProtocol.seen = []
			RecordingProtocol.status = status
			RecordingProtocol.json = json
		}
		let config = URLSessionConfiguration.ephemeral
		config.protocolClasses = [RecordingProtocol.self]
		return APIInviteRemote(
			baseURL: URL(string: "http://localhost:3000")!, clientSource: "test",
			session: URLSession(configuration: config))
	}
	private var seen: [RecordingProtocol.Seen] { RecordingProtocol.lock.withLock { RecordingProtocol.seen } }

	@Test("preview decodes and sends no credentials and no workspace header")
	func preview() async throws {
		let p = try await remote(status: 200, json: previewJSON).preview(token: "tok")
		#expect(p.workspaceName == "Mesh Firm")
		#expect(p.roleLabel == "Admin")
		#expect(p.expiresAt > Date())
		let s = try #require(seen.first)
		#expect(s.path == "/api/invites/preview?token=tok")
		#expect(s.authorization == nil)
		#expect(s.workspace == nil)
	}

	@Test("accept sends only the bearer key: no workspace header")
	func accept() async throws {
		let r = remote(
			status: 200,
			json: #"{"workspaceId":"22222222-2222-2222-2222-222222222222","actorId":"33333333-3333-3333-3333-333333333333"}"#)
		let a = try await r.accept(token: "tok", apiKey: "ank_k")
		#expect(a.workspaceId == "22222222-2222-2222-2222-222222222222")
		let s = try #require(seen.first)
		#expect(s.path == "/api/invites/tok/accept")
		#expect(s.method == "POST")
		#expect(s.authorization == "Bearer ank_k")
		#expect(s.workspace == nil)
	}

	@Test("preview error statuses map to the human cases")
	func previewErrors() async {
		// Bodies are the shapes the backend sends (workspace-invitations.ts): `{status}` for 404/410,
		// the standard error envelope for 429.
		let envelope = #"{"error":{"code":"RATE_LIMITED","message":"Too many","details":[]}}"#
		for (status, json, expected) in [
			(404, #"{"status":"not_found"}"#, InviteFailure.notFound), (410, #"{"status":"expired"}"#, .expired),
			(429, envelope, .rateLimited), (503, "{}", .server(status: 503)),
		] {
			let r = remote(status: status, json: json)
			await #expect(throws: expected) { try await r.preview(token: "tok") }
		}
	}

	@Test("accept error statuses map to the human cases")
	func acceptErrors() async {
		let envelope = #"{"error":{"code":"X","message":"x","details":[]}}"#
		for (status, expected) in [(401, InviteFailure.sessionExpired), (403, .seatCap), (404, .notFound), (410, .expired)] {
			let r = remote(status: status, json: envelope)
			await #expect(throws: expected) { try await r.accept(token: "tok", apiKey: "k") }
		}
	}
}
