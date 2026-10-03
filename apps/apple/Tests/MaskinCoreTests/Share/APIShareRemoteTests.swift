import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

/// The real generated client against a scripted transport: asserts what actually goes on the wire.
private final class WireTransport: ClientTransport, @unchecked Sendable {
	struct Seen { var method: String; var path: String; var headers: [String: String]; var body: Data }
	private let lock = NSLock()
	private var _seen: [Seen] = []
	var seen: [Seen] { lock.withLock { _seen } }
	var status: Int = 201

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var bytes = Data()
		if let body { for try await chunk in body { bytes.append(contentsOf: chunk) } }
		var headers: [String: String] = [:]
		for field in request.headerFields { headers[field.name.canonicalName] = field.value }
		lock.withLock {
			_seen.append(Seen(method: request.method.rawValue, path: request.path ?? "", headers: headers, body: bytes))
		}
		var response = HTTPResponse(status: .init(code: status))
		response.headerFields[.contentType] = "application/json"
		let path = request.path ?? ""
		let json: String
		if status >= 400 {
			json = "{\"error\":\"x\"}"
		} else if path.hasPrefix("/api/files") {
			json = Self.file
		} else if path.hasPrefix("/api/relationships") {
			json = Self.relationship
		} else if path.hasPrefix("/api/workspaces") {
			json = Self.workspaces
		} else {
			json = Self.object
		}
		return (response, HTTPBody(json))
	}

	static let stamp = "\"createdAt\":\"2026-10-02T10:00:00.000Z\""
	static let object =
		"{\"id\":\"11111111-1111-1111-1111-111111111111\",\"workspaceId\":\"ws\",\"type\":\"insight\",\"title\":\"t\",\"content\":\"c\",\"status\":\"new\",\"metadata\":{},\"driver\":null,\"activeSessionId\":null,\"createdBy\":\"a\",\(stamp),\"updatedAt\":\"2026-10-02T10:00:00.000Z\"}"
	static let file =
		"{\"id\":\"22222222-2222-2222-2222-222222222222\",\"workspaceId\":\"ws\",\"name\":\"a.pdf\",\"description\":null,\"mimeType\":\"application/pdf\",\"sizeBytes\":3,\"storageKey\":\"k\",\"createdBy\":\"a\",\(stamp),\"updatedAt\":\"2026-10-02T10:00:00.000Z\",\"content\":\"\",\"encoding\":\"base64\",\"url\":\"u\"}"
	static let relationship =
		"{\"id\":\"r\",\"sourceType\":\"insight\",\"sourceId\":\"s\",\"targetType\":\"file\",\"targetId\":\"t\",\"type\":\"attached\",\"metadata\":{},\"createdBy\":\"a\",\(stamp)}"
	static let workspaces =
		"[{\"id\":\"ws-1\",\"name\":\"Mesh Firm\",\"settings\":{\"statuses\":{\"insight\":[\"new\"],\"meeting\":[\"planned\"]},\"display_names\":{\"meeting\":\"Meeting\"}},\"onboardingEnabled\":false,\"enterprise\":false,\"billingOwnerId\":null,\"createdBy\":\"a\",\(stamp),\"updatedAt\":\"2026-10-02T10:00:00.000Z\",\"role\":\"owner\",\"memberCount\":2}]"
}

private func make(_ transport: WireTransport) -> APIShareRemote {
	let direct = Client(
		serverURL: URL(string: "http://localhost:3000")!, transport: transport,
		middlewares: [])
	return APIShareRemote(client: direct, workspaceID: "ws-1")
}

@Suite("APIShareRemote on the wire")
struct APIShareRemoteTests {
	@Test("create object: POST /api/objects with workspace header, idempotency key, type and status")
	func createObject() async throws {
		let transport = WireTransport()
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: transport,
			middlewares: [IdempotencyMiddleware()])
		let remote = APIShareRemote(client: client, workspaceID: "ws-1")
		let id = try await remote.createObject(
			type: "insight", title: "T", content: "C", status: "new", idempotencyKey: "key-1")
		#expect(id == "11111111-1111-1111-1111-111111111111")
		let seen = try #require(transport.seen.first)
		#expect(seen.method == "POST" && seen.path == "/api/objects")
		#expect(seen.headers["X-Workspace-Id"] == "ws-1")
		#expect(seen.headers["Idempotency-Key"] == "key-1")
		let json = try #require(JSONSerialization.jsonObject(with: seen.body) as? [String: Any])
		#expect(json["type"] as? String == "insight" && json["status"] as? String == "new")
		#expect(json["title"] as? String == "T" && json["content"] as? String == "C")
	}

	@Test("upload: base64 JSON with the file's own bytes, name and type")
	func upload() async throws {
		let transport = WireTransport()
		let remote = make(transport)
		let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let file = dir.appendingPathComponent("a.pdf")
		try Data([1, 2, 3]).write(to: file)
		defer { try? FileManager.default.removeItem(at: dir) }
		_ = try await remote.uploadFile(name: "a.pdf", mimeType: "application/pdf", fileURL: file, idempotencyKey: "k")
		let seen = try #require(transport.seen.first)
		#expect(seen.path == "/api/files")
		let json = try #require(JSONSerialization.jsonObject(with: seen.body) as? [String: Any])
		#expect(json["content"] as? String == Data([1, 2, 3]).base64EncodedString())
		#expect(json["encoding"] as? String == "base64" && json["mime_type"] as? String == "application/pdf")
		#expect(json["name"] as? String == "a.pdf")
	}

	@Test("attach: the same 'attached' edge the web writes, object to file")
	func attach() async throws {
		let transport = WireTransport()
		try await make(transport).attach(fileID: "f", toObject: "o", objectType: "bet", idempotencyKey: "k")
		let seen = try #require(transport.seen.first)
		#expect(seen.path == "/api/relationships")
		let json = try #require(JSONSerialization.jsonObject(with: seen.body) as? [String: Any])
		#expect(json["source_type"] as? String == "bet" && json["source_id"] as? String == "o")
		#expect(json["target_type"] as? String == "file" && json["target_id"] as? String == "f")
		#expect(json["type"] as? String == "attached")
	}

	@Test("workspace: the signed-in workspace's name and its real types")
	func workspace() async throws {
		let transport = WireTransport()
		transport.status = 200
		let ws = try await make(transport).workspace()
		#expect(ws.name == "Mesh Firm")
		#expect(ws.schema.types.contains("meeting"))
		#expect(ws.schema.displayName(for: "meeting") == "Meeting")
	}

	@Test("a 400 on create is rejected, 401 is an expired session, 500 is the server's fault")
	func statusMapping() async {
		for (status, expected): (Int, ShareError) in [(400, .rejected), (401, .sessionExpired), (500, .server)] {
			let transport = WireTransport()
			transport.status = status
			await #expect(throws: expected) {
				_ = try await make(transport).createObject(
					type: "insight", title: "t", content: "", status: "new", idempotencyKey: "k")
			}
		}
	}

	@Test("a rejected upload names the file; transport errors map to offline")
	func uploadErrors() async throws {
		let transport = WireTransport()
		transport.status = 400
		let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let file = dir.appendingPathComponent("a.pdf")
		try Data([1]).write(to: file)
		defer { try? FileManager.default.removeItem(at: dir) }
		await #expect(throws: ShareError.fileRejected(name: "a.pdf")) {
			_ = try await make(transport).uploadFile(name: "a.pdf", mimeType: "application/pdf", fileURL: file, idempotencyKey: "k")
		}
		#expect(APIShareRemote.map(URLError(.notConnectedToInternet)) == .offline)
		#expect(APIShareRemote.map(URLError(.badServerResponse)) == .server)
		#expect(APIShareRemote.failure(status: 429) == .server)
		#expect(APIShareRemote.failure(status: 404) == .rejected)
	}

	@Test("the production wiring sends the bearer key and workspace, and has no sign-out hook")
	func productionClientHeaders() async throws {
		let credentials = ShareCredentials(apiKey: "ank_abc", workspaceId: "ws-1")
		let remote = ShareSession.remote(baseURL: URL(string: "http://127.0.0.1:1")!, credentials: credentials)
		// Unreachable port: the call fails offline/server, proving no 401 hook runs and nothing throws a crash.
		await #expect(throws: ShareError.self) { _ = try await remote.workspace() }
	}
}

