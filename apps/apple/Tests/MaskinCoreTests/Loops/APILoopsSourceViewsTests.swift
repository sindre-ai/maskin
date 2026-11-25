import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinCore

/// Answers `GET /api/objects/{id}` the way the server does for a flow: the whole object, with the
/// list-valued metadata (views, targets, trigger ids) and the extra fields every object carries.
private final class FlowObjectTransport: ClientTransport, @unchecked Sendable {
	static let discoveryMetadata = """
		{"tags":["Product"],"views":[
		{"name":"Radar","file_id":"d8b5e848-14b8-4b1d-8070-cd6347177ac8"},
		{"name":"Opportunities","file_id":"1ff2c333-f081-48c8-8f6c-14e4ef8f75ea"},
		{"name":"Pipeline","file_id":"ad29b26b-e8ea-47e2-9eab-a03d29c207fa"},
		{"name":"Briefing","file_id":"bb54bdd0-4c58-4794-8738-8587ee68c732"}],
		"targets":[{"label":"x","actual":0,"target":15,"ownerActorId":"a"}],
		"trigger_ids":["t1"],"view_file_id":null,"closed_statuses":{"bet":["opportunity"]}}
		"""

	let metadata: String
	let status: HTTPResponse.Status

	init(metadata: String = discoveryMetadata, status: HTTPResponse.Status = .ok) {
		self.metadata = metadata
		self.status = status
	}

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		guard (request.path ?? "").contains("/api/objects/") else {
			return (HTTPResponse(status: .notFound), HTTPBody("{}"))
		}
		var response = HTTPResponse(status: status)
		response.headerFields[.contentType] = "application/json"
		guard status == .ok else { return (response, HTTPBody(#"{"error":{"code":"NOT_FOUND","message":"x"}}"#)) }
		let json = """
			{"id": "11111111-2222-3333-4444-555555555555", "workspaceId": "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa",
			"type": "loop", "title": "Product Discovery", "content": "Finds what to build next.", "status": "live",
			"metadata": \(metadata), "driver": null, "activeSessionId": null,
			"activeSessionCurrentActivity": null, "active_session_state": null, "last_session": null,
			"createdBy": "7d1f0c52-0e0a-4f43-9c1e-bbbbbbbbbbbb",
			"createdAt": "2026-10-20T10:00:00.000Z", "updatedAt": "2026-11-20T10:00:00.000Z",
			"next_step": null, "go_ahead": null, "done_when": null,
			"is_subscribed": true, "unread_count": 0, "subscriber_count": 2, "is_starred_by_me": false,
			"preview": null}
			"""
		return (response, HTTPBody(json))
	}
}

@Suite("Flow views read through the generated client")
struct APILoopsSourceViewsTests {
	private func source(_ transport: FlowObjectTransport) -> APILoopsSource {
		let client = Client(serverURL: URL(string: "http://localhost:3000")!, transport: transport)
		return APILoopsSource(client: client, workspaceID: "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa")
	}

	@Test("Product Discovery's by-id read gives its four views in order")
	func discoveryViews() async throws {
		let views = try await source(FlowObjectTransport()).views(loopID: "11111111-2222-3333-4444-555555555555")
		#expect(views.map(\.name) == ["Radar", "Opportunities", "Pipeline", "Briefing"])
		#expect(views.first?.fileID == "d8b5e848-14b8-4b1d-8070-cd6347177ac8")
	}

	@Test("a flow pinned before tabs existed still reads as one Custom view")
	func legacyView() async throws {
		let transport = FlowObjectTransport(metadata: #"{"view_file_id":"f9"}"#)
		let views = try await source(transport).views(loopID: "11111111-2222-3333-4444-555555555555")
		#expect(views == [LoopView(name: "Custom view", fileID: "f9")])
	}

	@Test("a flow with no views reads as none")
	func noViews() async throws {
		let transport = FlowObjectTransport(metadata: #"{"tags":["Product"]}"#)
		let views = try await source(transport).views(loopID: "11111111-2222-3333-4444-555555555555")
		#expect(views.isEmpty)
	}

	@Test("a refused read throws, so the screen can say so")
	func refused() async {
		let transport = FlowObjectTransport(status: .notFound)
		await #expect(throws: (any Error).self) {
			_ = try await source(transport).views(loopID: "11111111-2222-3333-4444-555555555555")
		}
	}
}
