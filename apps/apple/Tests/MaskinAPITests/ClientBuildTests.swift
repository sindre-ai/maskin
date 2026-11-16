import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI

private actor SentBuild {
	private(set) var value: String?
	func set(_ v: String?) { value = v }
}

private func send(clientBuild: String?) async throws -> String? {
	let sent = SentBuild()
	let middleware = MaskinAuthMiddleware(
		credentials: { nil }, clientSource: "ios", clientBuild: clientBuild)
	_ = try await middleware.intercept(
		HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/x"), body: nil,
		baseURL: URL(string: "http://localhost")!, operationID: "x"
	) { request, _, _ in
		await sent.set(request.headerFields[.xClientBuild])
		return (HTTPResponse(status: .ok), nil)
	}
	return await sent.value
}

@Suite("X-Client-Build")
struct ClientBuildTests {
	@Test("a timestamp build number is accepted, as is the longest allowed")
	func accepts() {
		#expect(ClientBuild.value(from: "2611081015") == "2611081015")
		#expect(ClientBuild.value(from: "123456789012") == "123456789012")
		#expect(ClientBuild.value(from: "1") == "1")
	}

	@Test("empty, too long, dotted or non-digit values are not sent")
	func rejects() {
		#expect(ClientBuild.value(from: nil) == nil)
		#expect(ClientBuild.value(from: "") == nil)
		#expect(ClientBuild.value(from: "1234567890123") == nil)
		#expect(ClientBuild.value(from: "1.2.3") == nil)
		#expect(ClientBuild.value(from: "12a4") == nil)
		#expect(ClientBuild.value(from: "١٢٣") == nil)
	}

	@Test("the main client sends the header when it has a build, and none when it has not")
	func middleware() async throws {
		#expect(try await send(clientBuild: "2611081015") == "2611081015")
		#expect(try await send(clientBuild: nil) == nil)
	}
}
