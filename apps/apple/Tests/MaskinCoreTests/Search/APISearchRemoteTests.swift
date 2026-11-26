import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinCore

@Suite("APISearchRemote server search")
struct APISearchRemoteTests {
	private struct NoTransport: ClientTransport {
		func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws
			-> (HTTPResponse, HTTPBody?)
		{
			(HTTPResponse(status: .notFound), nil)
		}
	}

	private func remote() -> APISearchRemote {
		APISearchRemote(
			client: Client(serverURL: URL(string: "https://example.test")!, transport: NoTransport()),
			baseURL: URL(string: "https://example.test")!, clientSource: "ios",
			credentials: { MaskinCredentials(apiKey: "ank_test", workspaceId: "ws-1") })
	}

	@Test("asks the one server search for the words, in the workspace, with the key")
	func request() async throws {
		let request = await remote().makeRequest(query: "csv export", participants: [], limit: 150)
		let url = try #require(request.url)
		let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(url.path == "/api/search")
		#expect(items.first { $0.name == "q" }?.value == "csv export")
		#expect(items.first { $0.name == "limit" }?.value == "150")
		#expect(items.first { $0.name == "types" } == nil, "every group, like the web")
		#expect(items.first { $0.name == "participants" } == nil)
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_test")
		#expect(request.value(forHTTPHeaderField: "X-Client-Source") == "ios")
	}

	@Test("picked people go along as a comma list, and the limit stays under the server's cap")
	func participants() async throws {
		let request = await remote().makeRequest(query: "", participants: ["a", "b"], limit: 900)
		let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(items.first { $0.name == "participants" }?.value == "a,b")
		#expect(items.first { $0.name == "q" } == nil)
		#expect(items.first { $0.name == "limit" }?.value == "150")
	}

	@Test("the page ranking asks for one type with every status, so archived rows are ranked too")
	func pageRankingRequest() async throws {
		let request = await remote().makeRequest(
			query: "cco", participants: [], limit: 150, types: ["agent"],
			statuses: ["needs_you", "in_progress", "new", "done", "archived"])
		let items = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(items.first { $0.name == "types" }?.value == "agent")
		#expect(items.first { $0.name == "statuses" }?.value == "needs_you,in_progress,new,done,archived")
		#expect(items.first { $0.name == "q" }?.value == "cco")
	}

	@Test("keeps the server's order across groups and maps each group to its kind")
	func decodes() throws {
		let json = """
			{"results":[
			 {"id":"a1","group":"agents","type":"agent","title":"CCO","sub":null,"snippet":"Commercial","status":"idle",
			  "statusGroup":"done","updatedAt":null},
			 {"id":"c1","group":"chats","type":"chat","title":"CCO plan","sub":"Me, Sam","snippet":"the plan",
			  "status":"unread","statusGroup":"needs_you","updatedAt":"2026-11-25T10:00:00.000Z"},
			 {"id":"l1","group":"loops","type":"loop","title":"CCO weekly","sub":null,"snippet":null,
			  "status":"in_progress","statusGroup":"in_progress","updatedAt":"2026-11-24T10:00:00.000Z"},
			 {"id":"p1","group":"people","type":"person","title":"Cco Person","sub":"p@example.test","snippet":null,
			  "status":"member","statusGroup":"done","updatedAt":null},
			 {"id":"o1","group":"objects","type":"task","title":"CCO task","sub":null,"snippet":"body",
			  "status":"in_review","statusGroup":"in_progress","updatedAt":null},
			 {"id":"t1","group":"automations","type":"automation","title":"CCO nightly","sub":"cron","snippet":null,
			  "status":"on","statusGroup":"done","updatedAt":null}],
			 "total":6,"capped":false,"partial":["automations"]}
			"""
		let answer = try APISearchRemote.decode(Data(json.utf8))
		#expect(answer.results.map(\.id) == ["agent:a1", "chat:c1", "object:l1", "object:o1"], "people and automations have no phone screen")
		#expect(answer.isPartial)
		#expect(answer.results[1].subtitle == "Me, Sam")
		#expect(answer.results[1].updatedAt != nil)
		#expect(answer.results[2].isFlow)
		#expect(answer.results[2].subtitle == "in progress")
		#expect(answer.results[3].detail == "task")
		#expect(answer.results[3].group == .objects)
	}

	@Test("an unreadable reply says to update the app")
	func unreadable() {
		#expect(throws: SearchError.self) { try APISearchRemote.decode(Data("{}".utf8)) }
	}
}
