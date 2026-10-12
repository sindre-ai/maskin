import Testing

@testable import MaskinCore

@Suite("Briefing chunks")
struct BriefingChunksTests {
	@Test("sentences are packed up to the limit and never split")
	func packs() {
		let script = "One short sentence. Another short sentence. A third sentence here."
		#expect(BriefingChunks.split(script: script, maxCharacters: 45) == [
			"One short sentence. Another short sentence.", "A third sentence here.",
		])
	}

	@Test("a paragraph break always starts a new slide")
	func paragraphs() {
		#expect(BriefingChunks.split(script: "First part.\nSecond part.", maxCharacters: 400) == [
			"First part.", "Second part.",
		])
	}

	@Test("one sentence longer than the limit stays whole")
	func longSentence() {
		let long = String(repeating: "word ", count: 80).trimmingCharacters(in: .whitespaces) + "."
		let chunks = BriefingChunks.split(script: long, maxCharacters: 60)
		#expect(chunks.count == 1)
		#expect(chunks[0] == long)
	}

	@Test("blank input has no slides")
	func empty() {
		#expect(BriefingChunks.split(script: "  \n \n").isEmpty)
	}
}
