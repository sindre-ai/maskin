import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

/// Answers every request from memory and records what was sent.
private final class DeviceProtocol: URLProtocol, @unchecked Sendable {
	struct Seen { var url: String; var method: String; var headers: [String: String] }
	nonisolated(unsafe) static var seen: [Seen] = []
	nonisolated(unsafe) static var status = 200
	nonisolated(unsafe) static var json = "{}"
	nonisolated(unsafe) static var fail = false
	static let lock = NSLock()

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		let r = request
		let (status, json, fail) = Self.lock.withLock { (Self.status, Self.json, Self.fail) }
		Self.lock.withLock {
			Self.seen.append(
				Seen(url: r.url?.absoluteString ?? "", method: r.httpMethod ?? "", headers: r.allHTTPHeaderFields ?? [:]))
		}
		if fail {
			client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
			return
		}
		let response = HTTPURLResponse(
			url: r.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: Data(json.utf8))
		client?.urlProtocolDidFinishLoading(self)
	}
	override func stopLoading() {}
}

private let tokenHex = String(repeating: "ab", count: 32)
private let deviceJSON = """
	{"id":"4f0c1c3e-8f4e-4f1a-9a55-0d1f2d1d9e11","actor_id":"a","platform":"ios","environment":"sandbox",
	"app_version":"1.2","created_at":"2026-10-21T00:00:00.000Z","last_seen_at":"2026-10-21T00:00:00.000Z"}
	"""

@Suite("APIDeviceRegistrar", .serialized)
struct APIDeviceRegistrarTests {
	private func registrar(status: Int = 200, json: String = "{}", fail: Bool = false) -> APIDeviceRegistrar {
		DeviceProtocol.lock.withLock {
			DeviceProtocol.seen = []
			DeviceProtocol.status = status
			DeviceProtocol.json = json
			DeviceProtocol.fail = fail
		}
		let config = URLSessionConfiguration.ephemeral
		config.protocolClasses = [DeviceProtocol.self]
		return APIDeviceRegistrar(
			baseURL: URL(string: "http://localhost:3000")!, clientSource: "ios",
			credentials: { MaskinCredentials(apiKey: "ank_secret", workspaceId: "ws-1") },
			session: URLSession(configuration: config))
	}
	private var seen: [DeviceProtocol.Seen] { DeviceProtocol.lock.withLock { DeviceProtocol.seen } }

	@Test("register request: URL, method, headers and no workspace header")
	func registerRequest() async throws {
		let r = registrar()
		let request = await r.makeRegisterRequest(idempotencyKey: "idem-1")
		#expect(request.url?.absoluteString == "http://localhost:3000/api/devices")
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_secret")
		#expect(request.value(forHTTPHeaderField: "X-Client-Source") == "ios")
		#expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "idem-1")
		#expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
		#expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == nil)
	}

	@Test("register body carries exactly the keys the server schema requires")
	func registerBody() throws {
		let data = try APIDeviceRegistrar.registerBody(
			token: tokenHex, environment: .sandbox, platform: .ios, appVersion: "1.2")
		let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
		#expect(
			json == ["platform": "ios", "apns_token": tokenHex, "environment": "sandbox", "app_version": "1.2"])
		let bare = try APIDeviceRegistrar.registerBody(
			token: tokenHex, environment: .production, platform: .macos, appVersion: nil)
		let keys = try #require(try JSONSerialization.jsonObject(with: bare) as? [String: String])
		#expect(keys["environment"] == "production")
		#expect(keys["platform"] == "macos")
		#expect(keys["app_version"] == nil)
	}

	@Test("register sends the request and returns the decoded device id")
	func registerReturnsId() async throws {
		let id = try await registrar(json: deviceJSON).register(
			token: tokenHex, environment: .sandbox, platform: .ios, appVersion: "1.2")
		#expect(id == "4f0c1c3e-8f4e-4f1a-9a55-0d1f2d1d9e11")
		let s = try #require(seen.first)
		#expect(s.method == "POST")
		#expect(s.url == "http://localhost:3000/api/devices")
		#expect(s.headers["Authorization"] == "Bearer ank_secret")
		#expect(s.headers["Idempotency-Key"]?.isEmpty == false)
	}

	@Test("an unreadable reply is a human error")
	func unreadableReply() async {
		await #expect(throws: NotificationsError("Maskin sent a reply this version can't read.")) {
			try await registrar(json: #"{"nope":1}"#).register(
				token: tokenHex, environment: .sandbox, platform: .ios, appVersion: nil)
		}
	}

	@Test("error statuses and network failures map to fixed messages without ids, keys or bodies")
	func errorMapping() async {
		let cases: [(Int, Bool, String)] = [
			(401, false, "Maskin didn't accept this sign-in. Sign in again to turn on notifications."),
			(403, false, "Maskin didn't accept this sign-in. Sign in again to turn on notifications."),
			(400, false, "Maskin couldn't register this device for notifications."),
			(500, false, "Maskin had a problem registering this device. Try again later."),
			(200, true, "Couldn't reach Maskin. Check your connection and try again."),
		]
		for (status, fail, message) in cases {
			let r = registrar(status: status, json: #"{"error":{"message":"ank_secret leaked"}}"#, fail: fail)
			do {
				_ = try await r.register(
					token: tokenHex, environment: .sandbox, platform: .ios, appVersion: nil)
				Issue.record("expected a throw for \(status)")
			} catch let error as NotificationsError {
				#expect(error.message == message)
				#expect(!error.message.contains("ank_secret"))
				#expect(!error.message.contains(tokenHex))
			} catch {
				Issue.record("wrong error type")
			}
		}
	}

	@Test("unregister deletes by device id; the token is never in the URL")
	func unregisterById() async throws {
		let r = registrar(json: #"{"deleted":true}"#)
		let request = await r.makeUnregisterRequest(deviceId: "4f0c1c3e-8f4e-4f1a-9a55-0d1f2d1d9e11")
		#expect(request.url?.absoluteString == "http://localhost:3000/api/devices/4f0c1c3e-8f4e-4f1a-9a55-0d1f2d1d9e11")
		#expect(request.httpMethod == "DELETE")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_secret")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == nil)
		try await r.unregister(deviceId: "4f0c1c3e-8f4e-4f1a-9a55-0d1f2d1d9e11")
		let s = try #require(seen.first)
		#expect(s.method == "DELETE")
		#expect(!s.url.contains(tokenHex))
	}

	@Test("unregister treats 404 as done and surfaces other failures")
	func unregisterStatuses() async throws {
		try await registrar(status: 404).unregister(deviceId: "gone")
		await #expect(throws: NotificationsError.self) {
			try await registrar(status: 401).unregister(deviceId: "x")
		}
		await #expect(throws: NotificationsError.self) {
			try await registrar(fail: true).unregister(deviceId: "x")
		}
	}
}
