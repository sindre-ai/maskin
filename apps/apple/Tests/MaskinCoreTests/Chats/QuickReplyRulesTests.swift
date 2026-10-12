import Foundation
import Testing

@testable import MaskinCore

@Suite("QuickReplyRules") struct QuickReplyRulesTests {
	private func agentMessage(_ text: String, metadata: JSONValue? = nil) -> ChatMessage {
		chatMsg(7, by: "relay", agent: true, text, metadata: metadata)
	}

	@Test("permission questions offer go-ahead, hold-off and check-first")
	func permission() {
		#expect(QuickReplyRules.intent(of: "Should I send the draft to legal?") == .permission)
		#expect(QuickReplyRules.intent(of: "I have a draft ready. Want me to send it?") == .permission)
		#expect(QuickReplyRules.replies(for: "Shall I go ahead?") == ["Yes, go ahead", "No, hold off", "Let me check first"])
	}

	@Test("capability questions offer can / not today / what do you need")
	func capability() {
		#expect(QuickReplyRules.intent(of: "Can you review the PR today?") == .capability)
		#expect(QuickReplyRules.intent(of: "Could you check the numbers?") == .capability)
		#expect(QuickReplyRules.replies(for: "Would you take a look?") == ["Yes, I can", "Not today", "What do you need?"])
	}

	@Test("when-questions offer times")
	func timing() {
		#expect(QuickReplyRules.intent(of: "When do you want the summary?") == .timing)
		#expect(QuickReplyRules.intent(of: "The brief is done. By when do you need the slides?") == .timing)
		#expect(QuickReplyRules.replies(for: "What time works?") == ["Today", "Tomorrow morning", "Later this week"])
	}

	@Test("any other question gets yes / no / tell me more")
	func general() {
		#expect(QuickReplyRules.intent(of: "Is the launch still on for Thursday?") == .general)
		#expect(QuickReplyRules.replies(for: "Does that match what you expected?") == ["Yes", "No", "Tell me more"])
	}

	@Test("statements, trailing quotes and the intent of an earlier sentence")
	func statements() {
		#expect(QuickReplyRules.intent(of: "The importer fix shipped.") == nil)
		#expect(QuickReplyRules.replies(for: "Done. I'll ping Sam.").isEmpty)
		#expect(QuickReplyRules.intent(of: "") == nil)
		// The question is the last sentence; a "should I" earlier in the text does not decide it.
		#expect(QuickReplyRules.intent(of: "Should I wait? Actually, is Sam back?") == .general)
		#expect(QuickReplyRules.intent(of: "Ready to ship?\"") == .general)
		#expect(QuickReplyRules.intent(of: "Can you?\n") == .capability)
	}

	@Test("chips show only for someone else's question with an empty composer and nobody typing")
	func gating() {
		let question = agentMessage("Should I send it?")
		#expect(
			QuickReplyRules.suggestions(latest: question, currentActorID: "me", composerEmpty: true, somebodyTyping: false)
				== ["Yes, go ahead", "No, hold off", "Let me check first"])
		#expect(QuickReplyRules.suggestions(latest: question, currentActorID: "me", composerEmpty: false, somebodyTyping: false).isEmpty)
		#expect(QuickReplyRules.suggestions(latest: question, currentActorID: "me", composerEmpty: true, somebodyTyping: true).isEmpty)
		#expect(QuickReplyRules.suggestions(latest: question, currentActorID: "relay", composerEmpty: true, somebodyTyping: false).isEmpty)
		#expect(QuickReplyRules.suggestions(latest: nil, currentActorID: "me", composerEmpty: true, somebodyTyping: false).isEmpty)
		#expect(
			QuickReplyRules.suggestions(latest: agentMessage("Shipped."), currentActorID: "me", composerEmpty: true, somebodyTyping: false)
				.isEmpty)
	}

	@Test("a flow ask keeps its own recommended options: no chips over a question card")
	func flowAskWins() {
		let ask: JSONValue = .object([
			"question": .object([
				"questions": .array([
					.object([
						"question": .string("Which environment?"), "header": .string("Env"),
						"options": .array([.object(["label": .string("Staging")])]),
					])
				])
			])
		])
		let message = agentMessage("Which environment should I deploy to?", metadata: ask)
		#expect(!message.questions.isEmpty)
		#expect(QuickReplyRules.suggestions(latest: message, currentActorID: "me", composerEmpty: true, somebodyTyping: false).isEmpty)
	}
}
