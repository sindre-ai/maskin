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

	@Test("reads the history with the key and the workspace")
	func readRequest() async throws {
		let request = await opens().makeRequest(method: "GET", body: nil)
		#expect(request.url?.path == "/api/search/opens")
		#expect(request.httpMethod == "GET")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_test")
	}

	@Test("an open is a POST with the entity id")
	func writeRequest() async throws {
		let body = try JSONEncoder().encode(["entity_id": "abc"])
		let request = await opens().makeRequest(method: "POST", body: body)
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
		let sent = try #require(request.httpBody)
		#expect(try JSONDecoder().decode([String: String].self, from: sent) == ["entity_id": "abc"])
	}

	@Test("decodes the bonuses by entity id")
	func decodes() throws {
		let json = #"{"opens":[{"entity_id":"a","bonus":150},{"entity_id":"b","bonus":50}]}"#
		let map = try APISearchOpens.decode(Data(json.utf8))
		#expect(map == ["a": 150, "b": 50])
	}
}
