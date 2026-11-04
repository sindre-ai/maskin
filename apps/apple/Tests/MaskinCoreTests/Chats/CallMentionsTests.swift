import Foundation
import Testing

@testable import MaskinCore

@Suite("CallMentions")
struct CallMentionsTests {
	let ws = "7d1f0c52-0e0a-4f43-9c1e-aaaaaaaaaaaa"

	private func message(_ id: Int, _ content: String, kind: String = "message") -> ChatMessage {
		ChatMessage(
			id: "m\(id)", serverID: id, conversationID: "c", actorID: "a", actorName: "Agent", author: .agent,
			kind: kind, content: content)
	}

	@Test("markdown links to objects come out newest message first, once each, titled by their text")
	func ordering() {
		let one = "11111111-2222-3333-4444-555555555555"
		let two = "22222222-2222-3333-4444-555555555555"
		let found = CallMentions.objects(in: [
			message(1, "See [Sentry task](https://maskin.io/\(ws)/objects/\(one))."),
			message(2, "Also [WP4 review](https://maskin.io/\(ws)/objects/\(two)) and [again](https://maskin.io/\(ws)/objects/\(one))."),
		])
		#expect(found.map(\.id) == [two, one])
		#expect(found.map(\.title) == ["WP4 review", "Sentry task"])
	}

	@Test("chats, files, foreign links and system lines are not objects")
	func filtering() {
		let id = "11111111-2222-3333-4444-555555555555"
		let found = CallMentions.objects(in: [
			message(1, "[a chat](https://maskin.io/\(ws)/chats/\(id)) [file](https://maskin.io/\(ws)/files/\(id))"),
			message(2, "[x](https://example.com/\(ws)/objects/\(id))"),
			message(3, "[sys](https://maskin.io/\(ws)/objects/\(id))", kind: "system"),
		])
		#expect(found.isEmpty)
	}

	@Test("a bare object URL still counts, titled Object")
	func bare() {
		let id = "11111111-2222-3333-4444-555555555555"
		let found = CallMentions.objects(in: [message(1, "look: https://maskin.io/\(ws)/objects/\(id) now")])
		#expect(found == [MentionedObject(id: id, title: "Object", workspaceId: ws)])
	}

	@Test("a text without a web address is not scanned, and one with links is scanned once")
	func linksAreSkippedOrCached() {
		let id = "11111111-2222-3333-4444-555555555555"
		let cache = LinkScanCache<[CallMentions.Link]>()
		#expect(CallMentions.links(in: "no address here, just words", cache: cache).isEmpty)
		#expect(cache.computeCount == 0)

		let text = "See [Sentry task](https://maskin.io/\(ws)/objects/\(id)) and https://example.com/x"
		let first = CallMentions.links(in: text, cache: cache)
		for _ in 0..<20 { #expect(CallMentions.links(in: text, cache: cache) == first) }
		#expect(cache.computeCount == 1)
		#expect(first.map(\.title) == ["Sentry task", "Object"])
	}
}
