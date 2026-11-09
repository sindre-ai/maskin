import Foundation
import Testing

@testable import MaskinCore

private let question: JSONValue = .object([
	"question": .object([
		"session_id": .string("s1"),
		"questions": .array([
			.object([
				"question": .string("When?"), "header": .string("Date"), "multi_select": .bool(false),
				"options": .array([.object(["label": .string("Now")])]),
			])
		]),
	])
])

private let helperQuestion: JSONValue = .object([
	"question": .object([
		"session_id": .string("s1"), "reply_to_session": .bool(true),
		"questions": .array([
			.object([
				"question": .string("When?"), "header": .string("Date"), "multi_select": .bool(false),
				"options": .array([.object(["label": .string("Now")])]),
			])
		]),
	])
])

private func ask(_ id: Int, root: Int? = nil, helper: Bool = false) -> ChatMessage {
	var m = chatMsg(id, by: "relay", agent: true, "When?", metadata: helper ? helperQuestion : question)
	m.threadRootID = root
	return m
}

private func said(_ id: Int, by actor: String = "me", root: Int? = nil) -> ChatMessage {
	var m = chatMsg(id, by: actor, "ok")
	m.threadRootID = root
	return m
}

@Suite("ChatQuestionState")
struct ChatQuestionStateTests {
	@Test("a normal message from this person after the question closes it")
	func typedReplyCloses() {
		let state = ChatQuestionState(messages: [ask(1), said(2)], viewerID: "me")
		#expect(state.answered == [1])
		#expect(state.answers[1] == [])
	}

	@Test("a message from someone else in a multi-person chat does not")
	func otherPersonDoesNotClose() {
		let state = ChatQuestionState(messages: [ask(1), said(2, by: "sam")], viewerID: "me")
		#expect(state.answered.isEmpty)
	}

	@Test("a reply still sending, or failed to send, does not close it")
	func unconfirmedDoesNotClose() {
		var sending = said(2)
		sending.serverID = nil
		sending.status = .sending
		var failed = said(3)
		failed.status = .failed("offline")
		#expect(ChatQuestionState(messages: [ask(1), sending, failed], viewerID: "me").answered.isEmpty)
	}

	@Test("system lines, agent messages and hidden card nudges are not replies")
	func notReplies() {
		var system = chatMsg(2, by: "me", "joined")
		system.kind = "system"
		let agent = chatMsg(3, by: "me", agent: true, "hello")
		let nudge = chatMsg(4, by: "me", "Done", metadata: .object(["hidden_from_chat": .bool(true)]))
		#expect(ChatQuestionState(messages: [ask(1), system, agent, nudge], viewerID: "me").answered.isEmpty)
	}

	@Test("a message written before the question closes nothing")
	func earlierMessageDoesNotClose() {
		#expect(ChatQuestionState(messages: [said(1), ask(2)], viewerID: "me").answered.isEmpty)
	}

	@Test("the order of the rows never decides it: server ids do")
	func orderIndependent() {
		let state = ChatQuestionState(messages: [said(2), ask(1)], viewerID: "me")
		#expect(state.answered == [1])
	}

	@Test("a helper's question is only answered by a pick")
	func helperQuestionStaysOpen() {
		#expect(ChatQuestionState(messages: [ask(1, helper: true), said(2)], viewerID: "me").answered.isEmpty)
	}

	@Test("a reply in a thread does not close a main-chat question, only its own thread's")
	func threadsAreSeparate() {
		#expect(ChatQuestionState(messages: [ask(1), said(2, root: 1)], viewerID: "me").answered.isEmpty)
		let inThread = ask(3, root: 1)
		#expect(ChatQuestionState(messages: [inThread, said(4, root: 1)], viewerID: "me").answered == [3])
		#expect(ChatQuestionState(messages: [inThread, said(4)], viewerID: "me").answered.isEmpty)
	}

	@Test("one reply closes only the newest open question, so an older one stays open")
	func closesOnlyTheNewestOpenQuestion() {
		#expect(ChatQuestionState(messages: [ask(1), ask(2), said(3)], viewerID: "me").answered == [2])
	}

	@Test("each later reply closes the next newest open question")
	func eachReplyClosesOne() {
		let state = ChatQuestionState(
			messages: [ask(1), ask(2), said(3), ask(4), said(5)], viewerID: "me")
		#expect(state.answered == [2, 4])
	}

	@Test("a question already picked is skipped when choosing the newest open one")
	func skipsPickedQuestion() {
		let pick = chatMsg(
			3, by: "me", "Now",
			metadata: .object([
				"question_answer": .object([
					"question_message_id": .number(2),
					"answers": .array([.object(["header": .string("Date"), "selected": .array([.string("Now")])])]),
				])
			]))
		let state = ChatQuestionState(messages: [ask(1), ask(2), pick, said(4)], viewerID: "me")
		#expect(state.answered == [1, 2])
	}

	@Test("a pick with no chosen option answers nothing, so the card stays")
	func emptyPickDoesNotAnswer() {
		func pick(_ id: Int, answers: JSONValue) -> ChatMessage {
			chatMsg(
				id, by: "sam", "x",
				metadata: .object([
					"question_answer": .object(["question_message_id": .number(1), "answers": answers])
				]))
		}
		let none = pick(2, answers: .array([]))
		let noneSelected = pick(3, answers: .array([.object(["header": .string("Date"), "selected": .array([])])]))
		let malformed = pick(4, answers: .string("nope"))
		#expect(ChatQuestionState(messages: [ask(1), none, noneSelected, malformed], viewerID: "me").answered.isEmpty)
	}

	@Test("a pick that lands after a typed close wins the summary, whatever the row order")
	func pickWinsOverTypedClose() {
		let pick = chatMsg(
			9, by: "me", "Now",
			metadata: .object([
				"question_answer": .object([
					"question_message_id": .number(1),
					"answers": .array([.object(["header": .string("Date"), "selected": .array([.string("Now")])])]),
				])
			]))
		let want = [ChatQuestionAnswer.Answer(header: "Date", selected: ["Now"])]
		#expect(ChatQuestionState(messages: [ask(1), said(2), pick], viewerID: "me").answers[1] == want)
		#expect(ChatQuestionState(messages: [ask(1), pick, said(10)], viewerID: "me").answers[1] == want)
	}
}
