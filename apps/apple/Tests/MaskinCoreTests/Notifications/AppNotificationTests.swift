import Foundation
import Testing

@testable import MaskinCore

@Suite("AppNotification mapping")
struct AppNotificationTests {
	private func make(type: String = "needs_input", status: String = "pending", metadata: [String: JSONValue]?) -> AppNotification {
		AppNotification.make(
			id: "n", workspaceId: "ws", type: type, title: "T", content: nil, metadata: metadata,
			sourceActorId: "a", targetActorId: nil, objectId: "obj", sessionId: nil, status: status,
			resolvedAt: nil, createdAt: nil)
	}

	@Test("actions with a response become buttons; variant picks the style")
	func actions() {
		let n = make(metadata: [
			"actions": .array([
				.object(["label": .string("Merge"), "response": .string("merged"), "variant": .string("default")]),
				.object(["label": .string("Skip"), "response": .string("skip")]),
				.object(["label": .string("Drop"), "response": .string("drop"), "variant": .string("destructive")]),
			])
		])
		#expect(n.actions.map(\.label) == ["Merge", "Skip", "Drop"])
		#expect(n.actions.map(\.style) == [.primary, .secondary, .destructive])
		#expect(n.actions[0].response == .string("merged"))
		#expect(n.canRespond)
	}

	@Test("malformed and navigate-only actions are skipped")
	func malformed() {
		let n = make(metadata: [
			"actions": .array([
				.string("nope"), .object(["label": .string("")]),
				.object(["label": .string("Open"), "navigate": .object(["to": .string("/x")])]),
				.object(["response": .string("orphan")]),
			])
		])
		#expect(n.actions.isEmpty)
		#expect(!n.canRespond)
	}

	@Test("options become buttons only when there are no actions")
	func options() {
		let n = make(metadata: [
			"options": .array([.object(["label": .string("Red"), "value": .string("r"), "description": .string("warm")])])
		])
		#expect(n.actions.first?.response == .string("r"))
		#expect(n.actions.first?.detail == "warm")
	}

	@Test("text input is detected")
	func text() {
		let n = make(metadata: ["input_type": .string("text"), "placeholder": .string("Say why")])
		#expect(n.wantsText)
		#expect(n.placeholder == "Say why")
		#expect(n.canRespond)
	}

	@Test("resolved rows can't be responded to and unknown values survive")
	func states() {
		let n = make(type: "brand_new", status: "frozen", metadata: ["input_type": .string("text")])
		#expect(n.kind == .other("brand_new"))
		#expect(n.status == .other("frozen"))
		#expect(!n.canRespond)
		#expect(make(status: "resolved", metadata: ["input_type": .string("text")]).canRespond == false)
		#expect(make(status: "seen", metadata: ["input_type": .string("text")]).canRespond)
	}

	@Test("nil metadata is fine; an object id links to the object")
	func link() {
		let n = make(metadata: nil)
		#expect(n.actions.isEmpty)
		#expect(n.deepLink() == .object(workspaceId: "ws", id: "obj"))
	}

	@Test("only pending counts as unread")
	func unread() {
		#expect(make(status: "pending", metadata: nil).isUnread)
		#expect(!make(status: "seen", metadata: nil).isUnread)
		#expect(!make(status: "resolved", metadata: nil).isUnread)
	}
}
