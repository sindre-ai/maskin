import Testing

@testable import MaskinFeatures

@Suite("LongMessage")
struct LongMessageTests {
	@Test("a short message is never folded")
	func short() {
		#expect(!LongMessage.isLong("Done. The merge is confirmed."))
	}

	@Test("a message over the character limit folds")
	func longByLength() {
		#expect(LongMessage.isLong(String(repeating: "word ", count: 80)))
	}

	@Test("a list with many short lines folds by line count")
	func longByLines() {
		let lines = (1...LongMessage.lines + 1).map { "- item \($0)" }.joined(separator: "\n")
		#expect(LongMessage.isLong(lines))
		#expect(!LongMessage.isLong((1...LongMessage.lines).map { "- item \($0)" }.joined(separator: "\n")))
	}
}
