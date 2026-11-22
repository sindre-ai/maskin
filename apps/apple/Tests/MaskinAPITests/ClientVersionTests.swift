import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI

private actor SentVersion {
	private(set) var value: String?
	func set(_ v: String?) { value = v }
}

private func send(clientVersion: String?) async throws -> String? {
	let sent = SentVersion()
	let middleware = MaskinAuthMiddleware(
		credentials: { nil }, clientSource: "ios", clientVersion: clientVersion)
	_ = try await middleware.intercept(
		HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/x"), body: nil,
		baseURL: URL(string: "http://localhost")!, operationID: "x"
	) { request, _, _ in
		await sent.set(request.headerFields[.xClientVersion])
		return (HTTPResponse(status: .ok), nil)
	}
	return await sent.value
}

@Suite("X-Client-Version")
struct ClientVersionTests {
	@Test("a release number is accepted, as is the longest allowed")
	func accepts() {
		#expect(ClientVersion.value(from: "1.2") == "1.2")
		#expect(ClientVersion.value(from: "1.12.3") == "1.12.3")
		#expect(ClientVersion.value(from: "123456789.01") == "123456789.01")
	}

	@Test("empty, too long or non-digit values are not sent")
	func rejects() {
		#expect(ClientVersion.value(from: nil) == nil)
		#expect(ClientVersion.value(from: "") == nil)
		#expect(ClientVersion.value(from: "1234567890.123") == nil)
		#expect(ClientVersion.value(from: "1.2-beta") == nil)
		#expect(ClientVersion.value(from: "1.2 ") == nil)
		#expect(ClientVersion.value(from: "١.٢") == nil)
	}

	@Test("the main client sends the header when it has a release, and none when it has not")
	func middleware() async throws {
		#expect(try await send(clientVersion: "1.2") == "1.2")
		#expect(try await send(clientVersion: nil) == nil)
	}
}
