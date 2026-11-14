import Foundation
import Testing

@testable import MaskinCore

@Suite("ObjectOrigin")
struct ObjectOriginTests {
	private func produced(
		session: String, to object: String = "o", by actor: String? = "agent", at seconds: TimeInterval
	) -> OriginEdge {
		OriginEdge(
			type: "produced_by", sourceType: "session", sourceId: session, targetType: "object", targetId: object,
			createdBy: actor, createdAt: Date(timeIntervalSince1970: seconds))
	}

	@Test("no session edge means no origin")
	func none() {
		let related = OriginEdge(type: "relates_to", sourceType: "object", sourceId: "x", targetType: "object", targetId: "o")
		#expect(ObjectOrigin.resolve(objectId: "o", edges: []) == nil)
		#expect(ObjectOrigin.resolve(objectId: "o", edges: [related]) == nil)
	}

	@Test("reads who ran the session and when, from the produced_by edge")
	func producedBy() {
		let origin = ObjectOrigin.resolve(objectId: "o", edges: [produced(session: "s1", at: 100)])
		#expect(origin == ObjectOrigin(sessionId: "s1", actorId: "agent", spawnedAt: Date(timeIntervalSince1970: 100)))
	}

	@Test("the oldest session wins: origin is where it began, not who touched it last")
	func oldest() {
		let edges = [produced(session: "late", at: 500), produced(session: "first", at: 100)]
		#expect(ObjectOrigin.resolve(objectId: "o", edges: edges)?.sessionId == "first")
	}

	@Test("an edge into another item is not this item's origin")
	func otherTarget() {
		#expect(ObjectOrigin.resolve(objectId: "o", edges: [produced(session: "s", to: "other", at: 1)]) == nil)
	}

	@Test("the chat that spawned the session comes from the spawned edge")
	func chat() {
		let spawned = OriginEdge(
			type: "spawned", sourceType: "conversation", sourceId: "chat-1", targetType: "session", targetId: "s1")
		let elsewhere = OriginEdge(
			type: "spawned", sourceType: "conversation", sourceId: "chat-2", targetType: "session", targetId: "s9")
		let origin = ObjectOrigin.resolve(objectId: "o", edges: [elsewhere, produced(session: "s1", at: 1), spawned])
		#expect(origin?.chatId == "chat-1")
	}
}
