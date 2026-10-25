import Testing

@testable import MaskinCore

@Suite("SpokenReply") struct SpokenReplyTests {
	@Test func shortPlainAnswerIsReadWhole() {
		#expect(SpokenReply.text(from: "Three bets are **blocked** on review.") == "Three bets are blocked on review.")
	}

	@Test func listHeavyAnswerIsSummarisedAndPointsAtTheChat() {
		let md = """
			Here are the blockers I found this morning. Most are waiting on review.

			- [Billing](https://maskin.io/a) waits on legal
			- [Search](https://maskin.io/b) waits on design
			- [Alerts](https://maskin.io/c) waits on review
			"""
		let spoken = SpokenReply.text(from: md)
		#expect(spoken.hasPrefix("Here are the blockers I found this morning."))
		#expect(spoken.hasSuffix(SpokenReply.pointer))
		#expect(!spoken.contains("legal") && !spoken.contains("http"))
	}

	@Test func answerThatStartsWithAListJustPointsAtTheChat() {
		let md = "- one\n- two\n- three\n- four"
		#expect(SpokenReply.text(from: md) == "I've put that in the chat.")
	}

	@Test func longProseIsCutAtASentenceEnd() {
		let sentence = "This sentence has exactly ten words in it, give or take. "
		let md = String(repeating: sentence, count: 12)
		let spoken = SpokenReply.text(from: md)
		let words = spoken.split(whereSeparator: \.isWhitespace).count
		#expect(words < 70 && spoken.hasSuffix(SpokenReply.pointer))
	}

	@Test func emptyStaysEmpty() {
		#expect(SpokenReply.text(from: "").isEmpty)
	}
}
