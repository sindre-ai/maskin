import Testing

@testable import MaskinCore

@Suite("PhrasePreviews")
struct PhrasePreviewsTests {
	@Test func showsTheWordsOfThePhraseBeingSpoken() {
		var previews = PhrasePreviews()
		previews.update(phrase: 0, text: "hello")
		previews.update(phrase: 0, text: "hello there")
		#expect(previews.text == "hello there")
	}

	@Test func theServerTextReplacesThePreviewOfItsPhrase() {
		var previews = PhrasePreviews()
		previews.update(phrase: 0, text: "hello their")
		previews.close(phrase: 0, sent: true)
		previews.update(phrase: 1, text: "how are")
		#expect(previews.text == "hello their how are")
		previews.serverDelivered()
		#expect(previews.text == "how are")
		previews.close(phrase: 1, sent: true)
		previews.serverDelivered()
		#expect(previews.text == "")
	}

	@Test func aPhraseTheServerAnswersWithNothingLeavesNoPreview() {
		var previews = PhrasePreviews()
		previews.update(phrase: 0, text: "mm")
		previews.close(phrase: 0, sent: true)
		previews.serverDelivered()
		#expect(previews.text == "")
	}

	@Test func previewsStayInSpeakingOrderWhileTheServerIsBehind() {
		var previews = PhrasePreviews()
		for (phrase, words) in ["one", "two", "three"].enumerated() {
			previews.update(phrase: phrase, text: words)
			previews.close(phrase: phrase, sent: true)
		}
		previews.serverDelivered()
		#expect(previews.text == "two three")
	}

	@Test func aDeliveryBeforeTheCloseIsStillCounted() {
		var previews = PhrasePreviews()
		previews.update(phrase: 0, text: "hello")
		previews.serverDelivered()
		previews.close(phrase: 0, sent: true)
		#expect(previews.text == "")
	}

	@Test func aLateFinalResultUpdatesAClosedPhrase() {
		var previews = PhrasePreviews()
		previews.update(phrase: 0, text: "hello")
		previews.close(phrase: 0, sent: true)
		previews.update(phrase: 0, text: "hello world")
		#expect(previews.text == "hello world")
	}

	@Test func aSilentPhraseNeverShows() {
		var previews = PhrasePreviews()
		previews.update(phrase: 0, text: "noise")
		previews.close(phrase: 0, sent: false)
		previews.update(phrase: 0, text: "noise again")
		previews.update(phrase: 1, text: "hello")
		#expect(previews.text == "hello")
	}
}
