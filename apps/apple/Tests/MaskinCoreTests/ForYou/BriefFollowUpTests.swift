import Foundation
import Testing

@testable import MaskinCore

@Suite("Brief follow-up")
struct BriefFollowUpTests {
	private func slide(headline: String = "Odds of 5.0 against 5.4", unit: String = "Soft funding") -> StoryCard {
		StoryCard(
			id: "s1", unit: unit, headline: headline, updatedAt: nil,
			content: .briefing(headline: headline, script: headline))
	}

	private func message(_ id: String, _ author: ChatParticipant.Kind, _ text: String) -> ChatMessage {
		ChatMessage(
			id: id, conversationID: "c", actorID: author == .agent ? "a" : "me", actorName: "x",
			author: author, content: text)
	}

	@Test("offers the two suggestions and names the Chief of Staff in the field")
	func wording() {
		#expect(BriefFollowUp.chips == ["Explain this slide", "Go ahead with this"])
		#expect(BriefFollowUp.placeholder == "Ask Chief of Staff about this slide")
	}

	@Test("a slide finds the same chat again by its title")
	func title() {
		#expect(BriefFollowUp.title(for: slide()) == "About: Odds of 5.0 against 5.4")
	}

	@Test("the first message names the slide and its unit; the panel shows only what was typed")
	func firstMessage() {
		let text = BriefFollowUp.firstMessage("Explain this slide", about: slide())
		#expect(text.hasPrefix("Re: Odds of 5.0 against 5.4 (from Soft funding)"))
		#expect(BriefFollowUp.displayText(text) == "Explain this slide")
		#expect(BriefFollowUp.displayText("Plain question") == "Plain question")
	}

	@Test("the exchange starts at the message this panel sent, not at older history")
	func exchange() {
		let all = [
			message("m1", .human, "old"), message("m2", .agent, "older answer"),
			message("local-x", .human, "Go ahead with this"), message("m3", .agent, "Done."),
		]
		#expect(BriefFollowUp.exchange(in: all, from: "local-x").map(\.id) == ["local-x", "m3"])
		#expect(BriefFollowUp.exchange(in: all, from: nil).isEmpty)
		#expect(BriefFollowUp.exchange(in: all, from: "missing").isEmpty)
	}

	@Test("a reply is awaited until an agent speaks after the question")
	func awaiting() {
		let asked = [message("local-x", .human, "Why?")]
		#expect(BriefFollowUp.isAwaitingReply(asked))
		#expect(!BriefFollowUp.isAwaitingReply(asked + [message("m3", .agent, "Because.")]))
		#expect(!BriefFollowUp.isAwaitingReply([]))
	}
}
