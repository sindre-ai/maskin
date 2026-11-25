import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@Suite("Search opens request")
struct APISearchOpensTests {
	private func opens() -> APISearchOpens {
		APISearchOpens(
			baseURL: URL(string: "https://example.test")!, clientSource: "ios",
			credentials: { MaskinCredentials(apiKey: "ank_test", workspaceId: "ws-1") })
	}

	@Test("an open is a POST with the entity id")
	func writeRequest() async throws {
		let body = try JSONEncoder().encode(["entity_id": "abc"])
		let request = await opens().makeRequest(method: "POST", body: body)
		#expect(request.url?.path == "/api/search/opens")
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_test")
		#expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
		let sent = try #require(request.httpBody)
		#expect(try JSONDecoder().decode([String: String].self, from: sent) == ["entity_id": "abc"])
	}
}
