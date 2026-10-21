import AVFoundation
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

@Suite("HandsFreeTracker")
struct HandsFreeTrackerTests {
	private func agentMsg(_ id: Int) -> ChatMessage { chatMsg(id, by: "relay", agent: true, "hello \(id)", at: 0) }
	private let now = chatT0.addingTimeInterval(10)

	@Test("never speaks the history that was loaded when the thread opened")
	func skipsInitialHistory() {
		var tracker = HandsFreeTracker()
		let history = [agentMsg(1), agentMsg(2)]
		#expect(tracker.newReplies(in: history, currentActorID: "me", now: now).isEmpty)  // not primed
		tracker.prime(with: history)
		#expect(tracker.newReplies(in: history, currentActorID: "me", now: now).isEmpty)
	}

	@Test("speaks every new reply, in order, not just the last")
	func speaksAllNewReplies() {
		var tracker = HandsFreeTracker()
		tracker.prime(with: [agentMsg(1)])
		let burst = [agentMsg(1), agentMsg(2), agentMsg(3)]
		#expect(tracker.newReplies(in: burst, currentActorID: "me", now: now).map(\.serverID) == [2, 3])
		#expect(tracker.newReplies(in: burst, currentActorID: "me", now: now).isEmpty)  // once only
	}

	@Test("skips own and human messages but still marks them seen")
	func skipsOthers() {
		var tracker = HandsFreeTracker()
		tracker.prime(with: [])
		let msgs = [chatMsg(1, by: "sam"), agentMsg(2)]
		#expect(tracker.newReplies(in: msgs, currentActorID: "me", now: now).map(\.serverID) == [2])
	}
}

@MainActor
@Suite("SpeechReader")
struct SpeechReaderStaleCallbackTests {
	@Test("a late callback for a replaced utterance does not end the current one")
	func staleCallbackIgnored() {
		let reader = SpeechReader()
		let first = AVSpeechUtterance(string: "one")
		let second = AVSpeechUtterance(string: "two")
		reader.adopt(first, id: "m1")
		reader.adopt(second, id: "m2")
		reader.utteranceDidEnd(ObjectIdentifier(first))
		#expect(reader.speakingID == "m2")
		reader.utteranceDidEnd(ObjectIdentifier(second))
		#expect(reader.speakingID == nil)
	}

	@Test("stop forgets the utterance, so its cancel callback is ignored")
	func stopThenLateCancel() {
		let reader = SpeechReader()
		let utterance = AVSpeechUtterance(string: "one")
		reader.adopt(utterance, id: "m1")
		reader.stop()
		reader.adopt(AVSpeechUtterance(string: "two"), id: "m2")
		reader.utteranceDidEnd(ObjectIdentifier(utterance))
		#expect(reader.speakingID == "m2")
	}
}
