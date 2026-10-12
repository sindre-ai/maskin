import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import MaskinAPI

@Suite("IdempotencyMiddleware")
struct IdempotencyTests {
	private func run(_ method: HTTPRequest.Method, key: String?, preset: String? = nil) async throws
		-> String?
	{
		var request = HTTPRequest(method: method, scheme: nil, authority: nil, path: "/api/x")
		if let preset { request.headerFields[IdempotencyMiddleware.header] = preset }
		let seen = Box()
		let call = {
			_ = try await IdempotencyMiddleware().intercept(
				request, body: nil, baseURL: URL(string: "http://x")!, operationID: "op"
			) { req, _, _ in
				seen.value = req.headerFields[IdempotencyMiddleware.header]
				return (HTTPResponse(status: .ok), nil)
			}
		}
		try await IdempotencyKey.$current.withValue(key, operation: call)
		return seen.value
	}

	@Test("stamps writes when a key is in scope")
	func stamps() async throws {
		#expect(try await run(.post, key: "k1") == "k1")
		#expect(try await run(.patch, key: "k1") == "k1")
		#expect(try await run(.delete, key: "k1") == "k1")
	}

	@Test("leaves reads and key-less writes alone")
	func skips() async throws {
		#expect(try await run(.get, key: "k1") == nil)
		#expect(try await run(.post, key: nil) == nil)
	}

	@Test("an explicit header wins")
	func explicit() async throws {
		#expect(try await run(.post, key: "k1", preset: "manual") == "manual")
	}
}

private final class Box: @unchecked Sendable { var value: String? }
