import Foundation
import Testing

@testable import MaskinCore

private func thumbs(_ count: Int, mine: Bool) -> MessageReaction {
	MessageReaction(emoji: "👍", count: count, reactedByMe: mine, people: mine ? [chatMe] : [chatSam])
}

@Suite("MessageReaction")
struct MessageReactionTests {
	@Test("adding a new emoji puts it last, counted once and marked as yours")
	func addNew() {
		let out = MessageReaction.toggling("✅", in: [thumbs(2, mine: false)], me: chatMe)
		#expect(out.map(\.emoji) == ["👍", "✅"])
		#expect(out.last?.count == 1 && out.last?.reactedByMe == true)
	}

	@Test("joining an emoji others used adds one and keeps its place")
	func join() {
		let out = MessageReaction.toggling("👍", in: [thumbs(2, mine: false)], me: chatMe)
		#expect(out.first?.count == 3 && out.first?.reactedByMe == true)
		#expect(out.first?.people.map(\.id) == ["sam", "me"])
	}

	@Test("taking back leaves the others, and the last one removes the chip")
	func takeBack() {
		let shared = MessageReaction.toggling("👍", in: [thumbs(2, mine: true)], me: chatMe)
		#expect(shared.first?.count == 1 && shared.first?.reactedByMe == false)
		let alone = MessageReaction.toggling("👍", in: [thumbs(1, mine: true)], me: chatMe)
		#expect(alone.isEmpty)
	}
}

@Suite("ChatStore reactions")
@MainActor
struct ChatStoreReactionTests {
	private func harness() -> ChatHarness {
		ChatHarness(server: [chatMsg(1, by: "sam", name: "Sam", "hello")])
	}

	@Test("a tap shows the chip at once and tells the server")
	func addsOptimistically() async throws {
		let h = harness()
		await h.store.start()
		let message = try #require(h.store.messages.first)
		await h.store.toggleReaction("👍", on: message)
		let shown = try #require(h.store.messages.first)
		#expect(shown.reactions.map(\.emoji) == ["👍"])
		#expect(shown.reactions.first?.reactedByMe == true)
		let calls = await h.api.reactCalls
		#expect(calls.first?.id == 1 && calls.first?.add == true && calls.count == 1)
	}

	@Test("a second tap takes it back")
	func removes() async throws {
		let h = harness()
		await h.store.start()
		let message = try #require(h.store.messages.first)
		await h.store.toggleReaction("👍", on: message)
		await h.store.toggleReaction("👍", on: message)
		#expect(h.store.messages.first?.reactions.isEmpty == true)
		#expect(await h.api.reactCalls.map(\.add) == [true, false])
	}

	@Test("when the server refuses, the chip goes back and a notice says so")
	func rollsBack() async throws {
		let h = harness()
		await h.store.start()
		await h.api.setFailReact(true)
		let message = try #require(h.store.messages.first)
		await h.store.toggleReaction("👍", on: message)
		#expect(h.store.messages.first?.reactions.isEmpty == true)
		#expect(h.store.notice == "Couldn't add the reaction.")
	}

	@Test("a reply in a thread can be reacted to too")
	func threadReply() async throws {
		var reply = chatMsg(2, by: "sam", "in thread")
		reply.threadRootID = 1
		let h = ChatHarness(server: [chatMsg(1), reply])
		await h.store.start()
		let inThread = try #require(h.store.replies(to: 1).first)
		await h.store.toggleReaction("❤️", on: inThread)
		#expect(h.store.replies(to: 1).first?.reactions.first?.emoji == "❤️")
	}
}
