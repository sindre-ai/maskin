import Testing

@testable import MaskinCore

@Suite("TextOffsets")
struct TextOffsetsTests {
	@Test func convertsAValidRangeToCharacterOffsets() {
		let text = "hello world"
		let range = text.index(text.startIndex, offsetBy: 6)..<text.endIndex
		#expect(TextOffsets.characterOffsets(of: range, in: text) == 6..<11)
	}

	@Test func countsCharactersNotScalars() {
		let text = "a👨‍👩‍👧b"
		let range = text.index(text.startIndex, offsetBy: 1)..<text.index(text.startIndex, offsetBy: 2)
		#expect(TextOffsets.characterOffsets(of: range, in: text) == 1..<2)
	}

	@Test func returnsNilForIndicesFromALongerString() {
		let old = "hello world"
		let stale = old.index(old.startIndex, offsetBy: 6)..<old.endIndex
		#expect(TextOffsets.characterOffsets(of: stale, in: "hi") == nil)
	}

	@Test func returnsNilForAnyIndexAgainstEmptyText() {
		let old = "draft"
		let stale = old.index(old.startIndex, offsetBy: 2)..<old.index(old.startIndex, offsetBy: 4)
		#expect(TextOffsets.characterOffsets(of: stale, in: "") == nil)
	}

	@Test func acceptsAnEmptyCaretAtTheEnd() {
		let text = "abc"
		#expect(TextOffsets.characterOffsets(of: text.endIndex..<text.endIndex, in: text) == 3..<3)
	}
}
