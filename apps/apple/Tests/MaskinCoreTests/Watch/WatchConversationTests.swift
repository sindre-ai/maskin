import Foundation
import Testing

@testable import MaskinCore

@Suite("Watch conversation")
struct WatchConversationTests {
	private func message(
		_ serverID: Int?, from actor: String, author: ChatParticipant.Kind, _ text: String, kind: String = "message"
	) -> ChatMessage {
		ChatMessage(
			id: "m\(serverID ?? 0)", serverID: serverID, conversationID: "c", actorID: actor, actorName: actor,
			author: author, kind: kind, content: text)
	}

	@Test("the answer is the Chief of Staff's newest message after the question")
	func answer() {
		let messages = [
			message(1, from: "cos", author: .agent, "Old answer"),
			message(2, from: "me", author: .human, "What is holding up the webhook fix?"),
			message(3, from: "cos", author: .agent, "The retry job."),
		]
		#expect(WatchConversation.answer(in: messages, after: 1, from: "cos")?.content == "The retry job.")
	}

	@Test("an earlier answer, a person's message and another agent's message are not the answer")
	func notTheAnswer() {
		let messages = [
			message(1, from: "cos", author: .agent, "Old answer"),
			message(2, from: "me", author: .human, "Question"),
			message(3, from: "dev", author: .agent, "Developer chimes in"),
			message(4, from: "cos", author: .agent, "Divider", kind: "system"),
		]
		#expect(WatchConversation.answer(in: messages, after: 1, from: "cos") == nil)
	}

	@Test("a brand new thread has no baseline, and an unconfirmed message never counts")
	func newThread() {
		#expect(WatchConversation.answer(in: [message(1, from: "cos", author: .agent, "Hi")], after: nil, from: "cos")?.content == "Hi")
		#expect(WatchConversation.answer(in: [message(nil, from: "cos", author: .agent, "Draft")], after: nil, from: "cos") == nil)
	}

	@Test("the pill under the microphone counts what waits")
	func pill() {
		#expect(WatchConversation.pill(count: 0) == "All clear")
		#expect(WatchConversation.pill(count: 1) == "1 needs you")
		#expect(WatchConversation.pill(count: 3) == "3 need you")
	}

	@Test("only a question gets quick replies")
	func question() {
		#expect(WatchConversation.asksQuestion("Send the follow-ups now? "))
		#expect(!WatchConversation.asksQuestion("The retry job is failing."))
	}

	@Test("the label says what the speaker is doing, or why it is silent")
	func label() {
		#expect(WatchConversation.stateLabel(speaking: true, muted: false, speechAllowed: true) == "SPEAKING")
		#expect(WatchConversation.stateLabel(speaking: false, muted: true, speechAllowed: true) == "MUTED")
		#expect(WatchConversation.stateLabel(speaking: false, muted: false, speechAllowed: false) == "TEXT ONLY")
		#expect(WatchConversation.stateLabel(speaking: false, muted: false, speechAllowed: true) == "DONE")
	}

	@Test("behind the scenes uses the session's own words, else a plain word for its state")
	func status() {
		#expect(WatchConversation.statusLine(activity: " Reading retry job logs ", presence: .working) == "Reading retry job logs")
		#expect(WatchConversation.statusLine(activity: nil, presence: .working) == "Working")
		#expect(WatchConversation.statusLine(activity: "", presence: .typing) == "Writing the answer")
		#expect(WatchConversation.statusLine(activity: nil, presence: .replying) == "Reading your message")
	}

	@Test("an empty question is never sent")
	@MainActor
	func emptyQuestion() {
		let store = WatchConversationStore { throw WatchConversationStore.SignedOut() }
		store.ask("   ")
		#expect(store.phase == .idle)
	}

	@Test("signed out says so instead of hanging")
	@MainActor
	func signedOut() async {
		let store = WatchConversationStore(timeout: .seconds(1), pollEvery: .milliseconds(10)) {
			throw WatchConversationStore.SignedOut()
		}
		store.ask("Hello")
		#expect(store.phase == .thinking)
		#expect(store.heard == "Hello")
		for _ in 0..<100 where store.phase == .thinking { try? await Task.sleep(for: .milliseconds(20)) }
		#expect(store.phase == .failed("Sign in to ask."))
	}
}
