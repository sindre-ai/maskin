import Foundation
import Testing

@testable import MaskinCore

@Suite("PushImage")
struct PushImageTests {
	@Test("accepts an https image url")
	func acceptsHTTPS() {
		let url = PushImage.url(from: ["image_url": "https://cdn.maskin.io/a.png"])
		#expect(url?.absoluteString == "https://cdn.maskin.io/a.png")
	}

	@Test("rejects http, other schemes, missing hosts, junk and over-long urls")
	func rejects() {
		#expect(PushImage.url(from: ["image_url": "http://x.test/a.png"]) == nil)
		#expect(PushImage.url(from: ["image_url": "file:///etc/passwd"]) == nil)
		#expect(PushImage.url(from: ["image_url": "https://"]) == nil)
		#expect(PushImage.url(from: ["image_url": 5]) == nil)
		#expect(PushImage.url(from: [:]) == nil)
		let long = "https://x.test/" + String(repeating: "a", count: PushImage.maxURLLength)
		#expect(PushImage.url(from: ["image_url": long]) == nil)
	}

	@Test("maps content types to the extension an attachment needs")
	func extensions() {
		#expect(PushImage.fileExtension(forMIMEType: "image/png") == "png")
		#expect(PushImage.fileExtension(forMIMEType: "image/JPEG; charset=binary") == "jpg")
		#expect(PushImage.fileExtension(forMIMEType: "text/html") == nil)
		#expect(PushImage.fileExtension(forMIMEType: nil) == nil)
	}

	@Test("enforces the size budget")
	func budget() {
		#expect(PushImage.isWithinBudget(1))
		#expect(PushImage.isWithinBudget(Int64(PushImage.maxBytes)))
		#expect(!PushImage.isWithinBudget(Int64(PushImage.maxBytes) + 1))
		#expect(!PushImage.isWithinBudget(0))
	}
}

@Suite("Server push contract")
struct ServerPushContractTests {
	/// Exactly what `buildApnsPayload` (apps/dev/src/services/apns.ts) emits for a decision push
	/// with an image. If the server shape changes, this and its twin in apns.test.ts must change
	/// together.
	private static let serverPayload = """
		{"aps":{"alert":{"title":"Ship it?","body":"Pick one"},"thread-id":"object:o-1",
		"mutable-content":1,"interruption-level":"time-sensitive","badge":3,"sound":"default",
		"category":"maskin.decision"},
		"deep_link":"maskin://ws-1/objects/o-1","notification_id":"n-1","workspace_id":"ws-1",
		"image_url":"https://cdn.maskin.io/a.png",
		"decision":{"eventId":42,"parentEventId":7,"objectId":"o-1",
		"options":[{"label":"Ship"},{"label":"Hold"}],"recommended":0}}
		"""

	@Test("the extension reads the decision and the image from a server-built payload")
	func readsServerPayload() throws {
		let json = try #require(
			try JSONSerialization.jsonObject(with: Data(Self.serverPayload.utf8)) as? [String: Any])
		let payload = try #require(PushDecisionPayload(userInfo: json))
		#expect(payload.options.map(\.label) == ["Ship", "Hold"])
		#expect(payload.options.first?.recommended == true)
		#expect(payload.eventId == 42 && payload.parentEventId == 7)
		#expect(PushImage.url(from: json)?.host == "cdn.maskin.io")
		let aps = try #require(json["aps"] as? [String: Any])
		#expect(aps["category"] as? String == PushDecisionPayload.category)
		#expect(aps["mutable-content"] as? Int == 1)
	}

	/// What `buildApnsPayload` emits for a chat reply: grouped per chat by `thread-id`, opening the
	/// chat through the existing deep link. iOS itself turns `thread-id` into the Notification
	/// Center group, so the client's part is to keep the link parseable and the key stable.
	private static let chatPayloads = [
		#"{"aps":{"alert":{"title":"Ada","body":"First"},"thread-id":"chat:c-9","mutable-content":1},"deep_link":"maskin://ws-1/chats/c-9","notification_id":"n-1"}"#,
		#"{"aps":{"alert":{"title":"Ada","body":"Second"},"thread-id":"chat:c-9","mutable-content":1},"deep_link":"maskin://ws-1/chats/c-9","notification_id":"n-2"}"#,
	]

	@Test("chat pushes share a thread and open that chat")
	func chatPush() throws {
		var threads = Set<String>()
		for raw in Self.chatPayloads {
			let json = try #require(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
			let aps = try #require(json["aps"] as? [String: Any])
			threads.insert(try #require(aps["thread-id"] as? String))
			let link = try #require(json["deep_link"] as? String)
			#expect(DeepLink(string: link) == .chat(workspaceId: "ws-1", id: "c-9"))
			#expect(PushDecisionPayload(userInfo: json) == nil, "a chat reply carries no decision buttons")
		}
		#expect(threads == ["chat:c-9"])
	}
}
