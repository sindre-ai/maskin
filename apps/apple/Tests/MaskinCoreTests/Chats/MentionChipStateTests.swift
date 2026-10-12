import Testing

@testable import MaskinCore

@Suite("MentionChipState")
struct MentionChipStateTests {
	private func message(_ serverID: Int, by actor: String, kind: ChatParticipant.Kind) -> ChatMessage {
		.confirmed(
			serverID: serverID, conversationID: "c", actorID: actor, actorName: actor, author: kind, content: "x")
	}

	@Test("an agent that answered afterwards is Replied, even while it is still running")
	func replied() {
		let mine = message(1, by: "me", kind: .human)
		let thread = [mine, message(2, by: "relay", kind: .agent)]
		let state = MentionChipState.resolve(
			mentionedID: "relay", kind: .agent, after: mine, in: thread, working: true)
		#expect(state == .replied)
	}

	@Test("a running agent that has not answered is Working")
	func working() {
		let mine = message(1, by: "me", kind: .human)
		let state = MentionChipState.resolve(
			mentionedID: "relay", kind: .agent, after: mine, in: [mine], working: true)
		#expect(state == .working)
	}

	@Test("an unanswered person is waited for; an idle agent is tagged")
	func waitingAndTagged() {
		let mine = message(1, by: "me", kind: .human)
		#expect(
			MentionChipState.resolve(mentionedID: "sam", kind: .human, after: mine, in: [mine], working: false)
				== .waiting)
		#expect(
			MentionChipState.resolve(mentionedID: "relay", kind: .agent, after: mine, in: [mine], working: false)
				== .tagged)
	}

	@Test("a reply before the message does not count")
	func earlierReplyIgnored() {
		let early = message(1, by: "sam", kind: .human)
		let mine = message(2, by: "me", kind: .human)
		#expect(
			MentionChipState.resolve(mentionedID: "sam", kind: .human, after: mine, in: [early, mine], working: false)
				== .waiting)
	}

	@Test("labels name the person")
	func labels() {
		#expect(MentionChipState.waiting.label(name: "Sam") == "Waiting for Sam")
		#expect(MentionChipState.working.label(name: "Relay") == "Relay · Working")
	}
}
