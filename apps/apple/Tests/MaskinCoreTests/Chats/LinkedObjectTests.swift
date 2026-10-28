import Foundation
import Testing

@testable import MaskinCore

@Suite("LinkedObject summary")
struct LinkedObjectTests {
	@Test("the first lines of the text read as plain words")
	func plainWords() {
		let text = "## Why\n\nThe **login** page keeps asking for the [code](https://x.io/c) twice.\n\n- Check `retry` first"
		#expect(
			LinkedObject.summary(from: text)
				== "Why The login page keeps asking for the code twice. Check retry first")
	}

	@Test("an object with no text has no summary")
	func empty() {
		#expect(LinkedObject.summary(from: nil) == nil)
		#expect(LinkedObject.summary(from: "  \n\n") == nil)
		#expect(LinkedObject.summary(from: "---\n```\n") == nil)
	}

	@Test("a long text is cut, and a name with underscores keeps them")
	func longText() {
		let long = String(repeating: "word ", count: 200)
		#expect((LinkedObject.summary(from: long)?.count ?? 0) <= LinkedObject.summaryCharacters)
		#expect(LinkedObject.summary(from: "set max_retry_count to 3") == "set max_retry_count to 3")
	}
}
