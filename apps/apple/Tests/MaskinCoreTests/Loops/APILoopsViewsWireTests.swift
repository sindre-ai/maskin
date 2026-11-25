import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

/// Answers every request with one scripted body and keeps what was asked.
private final class ObjectTransport: ClientTransport, @unchecked Sendable {
	struct Seen { var method: String; var path: String; var headers: [String: String] }
	private let lock = NSLock()
	private var _seen: [Seen] = []
	var seen: [Seen] { lock.withLock { _seen } }
	let status: Int
	let body: String

	init(status: Int = 200, body: String) {
		self.status = status
		self.body = body
	}

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var headers: [String: String] = [:]
		for field in request.headerFields { headers[field.name.canonicalName] = field.value }
		lock.withLock {
			_seen.append(Seen(method: request.method.rawValue, path: request.path ?? "", headers: headers))
		}
		var response = HTTPResponse(status: .init(code: status))
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(self.body))
	}
}

/// The flow's views read, from the real client call down to the tab rows: what the phone does to
/// show view tabs, with the server's answer scripted instead of a device.
@Suite("Flow views through the generated client")
struct APILoopsViewsWireTests {
	private static let flowID = "f3854654-3902-42d4-b9a3-91833c62833b"
	private static let workspace = "e2877e32-2c11-489e-96c8-a76200908ed4"

	/// Product release as GET /api/objects/{id} answers it: the metadata is the live one (read
	/// 25 Nov 2026), the rest is every field the route adds around an object, filled the way a flow
	/// that is running looks (an open next step, a last session, no preview).
	private static let productReleaseBody = #"""
		{"id":"\#(flowID)","workspaceId":"\#(workspace)","type":"loop","title":"Product release",
		"content":"Every user-facing change is released and written up.","status":"live",
		"metadata":{"tags":["Delivery"],
		"views":[{"name":"Results","file_id":"68819572-12bd-4255-85c5-ab3d9e84ae92"}],
		"targets":[{"label":"Release checks per week","actual":1,"source":"Weekdays.","target":5,
		"pace_policy":"window","ownerActorId":"16857135-83f8-4fdc-89be-0130ca19a695"}],
		"trigger_ids":["e4552b79-961d-46ce-a422-7788dca59e70"],"view_file_id":null,
		"close_condition":"The release is live.","closed_statuses":{"task":["done","discarded"]},
		"entry_condition":"A user-facing change has merged to main."},
		"driver":"16857135-83f8-4fdc-89be-0130ca19a695","activeSessionId":null,
		"activeSessionCurrentActivity":null,"active_session_state":null,
		"last_session":{"id":"4dade2e2-029b-4a89-be8d-8c60cb79e183","status":"completed",
		"agent_id":"16857135-83f8-4fdc-89be-0130ca19a695","started_at":"2026-11-25T19:00:33.905Z",
		"failure_reason":null,"chat_id":null,"created_by_actor_id":"2e772113-48d0-410d-82e6-2414881581fc"},
		"createdBy":"16857135-83f8-4fdc-89be-0130ca19a695","createdAt":"2026-11-10T09:00:00.000Z",
		"updatedAt":"2026-11-25T09:00:00.000Z","is_subscribed":true,"unread_count":0,
		"subscriber_count":2,"is_starred_by_me":false,"preview":null,
		"next_step":{"id":"b8c0b8a0-6d7a-4a43-9a52-0d3f7a4b9f11","object_id":"\#(flowID)",
		"action":"Check the next release","owner_id":"16857135-83f8-4fdc-89be-0130ca19a695",
		"due_at":"2026-11-26T08:00:00.000Z","status":"open","blocked_on_object_id":null,
		"blocked_on_actor_id":null,"blocked_on_decision_comment_id":null,"blocked_reason":null,
		"evidence":null,"wake_count":0,"created_by":"16857135-83f8-4fdc-89be-0130ca19a695",
		"created_at":"2026-11-25T09:00:00.000Z","updated_at":"2026-11-25T09:00:00.000Z","closed_at":null},
		"go_ahead":null,"done_when":null}
		"""#

	private func source(_ transport: ObjectTransport) -> APILoopsSource {
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: transport,
			middlewares: [
				MaskinAuthMiddleware(
					credentials: { MaskinCredentials(apiKey: "key", workspaceId: Self.workspace) },
					clientSource: "ios")
			])
		return APILoopsSource(client: client, workspaceID: Self.workspace)
	}

	@Test("Product release: the real by-id answer comes back as its Results tab")
	func resultsTab() async throws {
		let transport = ObjectTransport(body: Self.productReleaseBody)
		let views = try await source(transport).views(loopID: Self.flowID)
		#expect(views == [LoopView(name: "Results", fileID: "68819572-12bd-4255-85c5-ab3d9e84ae92")])
		let seen = try #require(transport.seen.first)
		#expect(seen.method == "GET" && seen.path == "/api/objects/\(Self.flowID)")
		#expect(seen.headers["x-workspace-id"] == Self.workspace)
	}

	@Test("a flow with several views keeps them in order, and one with none gives none")
	func manyAndNone() async throws {
		let results = #"{"name":"Results","file_id":"68819572-12bd-4255-85c5-ab3d9e84ae92"}"#
		let radar = #"{"name":"Radar","file_id":"d8b5e848-14b8-4b1d-8070-cd6347177ac8"}"#
		let briefing = #"{"name":"Briefing","file_id":"bb54bdd0-4c58-4794-8738-8587ee68c732"}"#
		let several = Self.productReleaseBody.replacingOccurrences(
			of: "\"views\":[\(results)]", with: "\"views\":[\(radar),\(briefing)]")
		#expect(several != Self.productReleaseBody)
		let two = try await source(ObjectTransport(body: several)).views(loopID: Self.flowID)
		#expect(two.map(\.name) == ["Radar", "Briefing"])
		let none = Self.productReleaseBody.replacingOccurrences(
			of: "\"views\":[\(results)],", with: "")
		#expect(none != Self.productReleaseBody)
		#expect(try await source(ObjectTransport(body: none)).views(loopID: Self.flowID).isEmpty)
	}

	@Test("a server error is thrown, so the screen can say the views did not load")
	func serverError() async {
		let transport = ObjectTransport(status: 500, body: #"{"error":{"code":"x","message":"x"}}"#)
		await #expect(throws: (any Error).self) {
			_ = try await source(transport).views(loopID: Self.flowID)
		}
	}
}
