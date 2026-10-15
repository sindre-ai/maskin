import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI

private actor Seen {
	private(set) var keys: [String] = []
	func add(_ k: String) { keys.append(k) }
}

private func run(
	status: HTTPResponse.Status, key: String?, seen: Seen
) async throws {
	let middleware = MaskinAuthMiddleware(
		credentials: { key.map { MaskinCredentials(apiKey: $0) } }, clientSource: "test",
		onUnauthorized: { await seen.add($0) })
	_ = try await middleware.intercept(
		HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/x"), body: nil,
		baseURL: URL(string: "http://localhost")!, operationID: "x"
	) { _, _, _ in (HTTPResponse(status: status), nil) }
}

@Suite("401 reaches the app")
struct UnauthorizedMiddlewareTests {
	@Test("a 401 to a request that carried a key reports that key")
	func reports() async throws {
		let seen = Seen()
		try await run(status: .unauthorized, key: "ank_dead", seen: seen)
		#expect(await seen.keys == ["ank_dead"])
	}

	@Test("a 401 with no key (login) and other statuses report nothing")
	func quiet() async throws {
		let seen = Seen()
		try await run(status: .unauthorized, key: nil, seen: seen)
		try await run(status: .forbidden, key: "ank_x", seen: seen)
		try await run(status: .ok, key: "ank_x", seen: seen)
		#expect(await seen.keys.isEmpty)
	}
}
