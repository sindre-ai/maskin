import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("QuoteJump")
struct QuoteJumpTests {
	private func msg(_ id: Int, _ name: String, _ text: String) -> ChatMessage {
		.confirmed(
			serverID: id, conversationID: "c", actorID: name, actorName: name, author: .human, kind: "text",
			content: text, createdAt: Date(timeIntervalSince1970: Double(id)))
	}

	@Test("finds the newest earlier message by the quoted author starting with the quoted words")
	func finds() throws {
		let a = msg(1, "Sam", "Ship it on Friday")
		let b = msg(2, "Sam", "Ship it on Friday, really")
		let reply = msg(3, "Alex", ChatQuote.make(author: "Sam", content: "Ship it on Friday, really") + "Ok")
		let quote = try #require(reply.quotedReply)
		#expect(QuoteJump.original(of: quote, replyID: reply.id, in: [a, b, reply])?.id == b.id)
	}

	@Test("an uncut quote jumps to the equal message, not a longer newer one")
	func exactBeatsLonger() throws {
		let a = msg(1, "Sam", "Ship it on Friday")
		let b = msg(2, "Sam", "Ship it on Friday, really")
		let reply = msg(3, "Alex", ChatQuote.make(author: "Sam", content: "Ship it on Friday") + "Ok")
		let quote = try #require(reply.quotedReply)
		#expect(QuoteJump.original(of: quote, replyID: reply.id, in: [a, b, reply])?.id == a.id)
	}

	@Test("quoting a message that is itself a reply still finds it")
	func nestedReply() throws {
		let original = msg(1, "Sam", "Ship it")
		let inner = msg(2, "Kim", ChatQuote.make(author: "Sam", content: "Ship it") + "Agreed")
		let reply = msg(3, "Alex", ChatQuote.make(author: "Kim", content: inner.content) + "Same")
		let quote = try #require(reply.quotedReply)
		#expect(QuoteJump.original(of: quote, replyID: reply.id, in: [original, inner, reply])?.id == inner.id)
	}

	@Test("matches a truncated quote and ignores other authors")
	func truncated() throws {
		let other = msg(1, "Kim", "one two three")
		let reply = msg(2, "Alex", "> **Sam**\n> one two…\n\nyes")
		let quote = try #require(reply.quotedReply)
		#expect(QuoteJump.original(of: quote, replyID: reply.id, in: [other, reply]) == nil)
	}

	@Test("a quoted id wins over text, and falls back to text when that message is not loaded")
	func byID() throws {
		let a = msg(1, "Sam", "Same words")
		let b = msg(2, "Sam", "Same words")
		let reply = msg(3, "Alex", ChatQuote.make(author: "Sam", content: "Same words") + "Ok")
		let quote = try #require(reply.quotedReply)
		#expect(QuoteJump.original(of: quote, replyID: reply.id, quotedID: 1, in: [a, b, reply])?.id == a.id)
		#expect(QuoteJump.original(of: quote, replyID: reply.id, quotedID: 99, in: [a, b, reply])?.id == b.id)
	}
}
