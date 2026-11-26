import Testing

@testable import MaskinFeatures

@Suite("ComposerSendGate")
struct ComposerSendGateTests {
	@Test("a file alone in Message agent mode keeps Send off, with a reason")
	func messageModeFileAlone() {
		let reason = ComposerSendGate.blocker(
			hasWords: false, hasFiles: true, editing: false, needsWords: ComposerSendGate.messageNeedsWords)
		#expect(reason == ComposerSendGate.messageNeedsWords)
	}

	@Test("a file alone in an edit keeps Send off, with a reason")
	func editFileAlone() {
		let reason = ComposerSendGate.blocker(hasWords: false, hasFiles: true, editing: true, needsWords: nil)
		#expect(reason == ComposerSendGate.editNeedsWords)
	}

	@Test("words lift both blocks")
	func wordsAllowSend() {
		let message = ComposerSendGate.blocker(
			hasWords: true, hasFiles: true, editing: false, needsWords: ComposerSendGate.messageNeedsWords)
		#expect(message == nil)
		#expect(ComposerSendGate.blocker(hasWords: true, hasFiles: true, editing: true, needsWords: nil) == nil)
	}

	@Test("a chat or comment bar with a file alone is not blocked")
	func chatAndCommentUnchanged() {
		#expect(ComposerSendGate.blocker(hasWords: false, hasFiles: true, editing: false, needsWords: nil) == nil)
	}

	@Test("an empty bar needs no reason: it shows the mic")
	func emptyBar() {
		#expect(ComposerSendGate.blocker(hasWords: false, hasFiles: false, editing: true, needsWords: nil) == nil)
		let reason = ComposerSendGate.messageNeedsWords
		#expect(ComposerSendGate.blocker(hasWords: false, hasFiles: false, editing: false, needsWords: reason) == nil)
	}
}
