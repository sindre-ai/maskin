import Foundation
import Testing

@testable import MaskinCore

@Suite("SpeakableText")
struct SpeakableTextTests {
	@Test("strips headings, emphasis, inline code and list markers")
	func inline() {
		let md = "# Plan\n\n**Bold** and _italic_ with `code`.\n- one\n- two\n1. first"
		#expect(SpeakableText.from(markdown: md) == "Plan\n\nBold and italic with code.\none\ntwo\nfirst")
	}

	@Test("keeps link labels, drops urls and images")
	func links() {
		let md = "See [the docs](https://x.io/a) or https://x.io/b ![chart](https://x.io/c.png)"
		#expect(SpeakableText.from(markdown: md) == "See the docs or link")
	}

	@Test("replaces fenced code with one short note")
	func fences() {
		let md = "Run:\n```sh\npnpm test\n```\nthen\n```\nmore\n```\ndone"
		#expect(SpeakableText.from(markdown: md) == "Run:\nCode block skipped.\nthen\ndone")
	}

	@Test("reads tables as cells and drops separators and rules")
	func tables() {
		let md = "| Name | Count |\n| --- | --- |\n| Relay | 3 |\n\n---\nEnd"
		#expect(SpeakableText.from(markdown: md) == "Name, Count\nRelay, 3\n\nEnd")
	}

	@Test("keeps snake_case and arithmetic intact")
	func snake() {
		#expect(SpeakableText.from(markdown: "use my_var_name and 2*3*4") == "use my_var_name and 2*3*4")
	}

	@Test("empty markup yields empty text")
	func empty() {
		#expect(SpeakableText.from(markdown: "```\ncode\n```") == "Code block skipped.")
		#expect(SpeakableText.from(markdown: "   \n").isEmpty)
	}
}

@Suite("SpeechPolicy")
struct SpeechPolicyTests {
	private func agentMsg(_ id: Int, at offset: TimeInterval = 0) -> ChatMessage {
		chatMsg(id, by: "relay", agent: true, "hello", at: offset)
	}

	@Test("speaks a fresh agent reply")
	func fresh() {
		let m = agentMsg(1)
		#expect(SpeechPolicy.shouldAutoSpeak(m, currentActorID: "me", now: chatT0.addingTimeInterval(30)))
	}

	@Test("ignores stale backlog, own messages and humans")
	func ignored() {
		let now = chatT0.addingTimeInterval(1000)
		#expect(!SpeechPolicy.shouldAutoSpeak(agentMsg(1), currentActorID: "me", now: now))
		let now2 = chatT0.addingTimeInterval(5)
		#expect(!SpeechPolicy.shouldAutoSpeak(agentMsg(1), currentActorID: "relay", now: now2))
		#expect(!SpeechPolicy.shouldAutoSpeak(chatMsg(2, by: "sam"), currentActorID: "me", now: now2))
	}
}
