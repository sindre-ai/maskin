import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@Suite("WorkspaceEvent decoding")
struct WorkspaceEventTests {
	@Test("decodes the live snake_case push")
	func live() {
		let sse = SSEEvent(
			id: "42", event: "updated",
			data: #"{"workspace_id":"w1","actor_id":"a1","action":"updated","entity_type":"object","entity_id":"o1","event_id":"42"}"#
		)
		let e = WorkspaceEvent(sse: sse)
		#expect(e?.id == "42")
		#expect(e?.workspaceId == "w1")
		#expect(e?.actorId == "a1")
		#expect(e?.entityType == .object)
		#expect(e?.entityId == "o1")
		#expect(e?.data == nil)
	}

	@Test("decodes the camelCase replay row with numeric id, data and date")
	func replay() {
		let sse = SSEEvent(
			id: "7", event: "created",
			data: #"{"id":7,"workspaceId":"w1","actorId":null,"action":"created","entityType":"conversation","entityId":"c1","data":{"title":"Hi","n":2},"createdAt":"2026-10-01T10:00:00.123Z"}"#
		)
		let e = WorkspaceEvent(sse: sse)
		#expect(e?.id == "7")
		#expect(e?.actorId == nil)
		#expect(e?.entityType == .conversation)
		#expect(e?.data?["title"]?.stringValue == "Hi")
		#expect(e?.createdAt != nil)
	}

	@Test("unknown entity types and extra fields are kept, not rejected")
	func tolerant() {
		let sse = SSEEvent(
			id: nil, event: "weird",
			data: #"{"entity_type":"hologram","event_id":"9","future":{"x":[1,2]}}"#)
		let e = WorkspaceEvent(sse: sse)
		#expect(e?.entityType.rawValue == "hologram")
		#expect(e?.action == "weird")
		#expect(e?.entityId == nil)
	}

	@Test("garbage frames decode to nil instead of throwing")
	func garbage() {
		#expect(WorkspaceEvent(sse: SSEEvent(id: "1", event: "x", data: "not json")) == nil)
		#expect(WorkspaceEvent(sse: SSEEvent(id: "1", event: "x", data: "[1,2]")) == nil)
		#expect(WorkspaceEvent(sse: SSEEvent(id: "1", event: "x", data: "{}")) == nil)
	}
}
