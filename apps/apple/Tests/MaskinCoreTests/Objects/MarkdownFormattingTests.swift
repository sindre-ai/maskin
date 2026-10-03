import Testing

@testable import MaskinCore

@Suite struct MarkdownFormattingTests {
	@Test func boldWrapsSelection() {
		let edit = MarkdownFormatting.apply(.bold, to: "make it loud", selection: 8..<12)
		#expect(edit.text == "make it **loud**")
		#expect(edit.selection == 10..<14)
	}

	@Test func boldAtCaretInsertsMarkersAroundTheCaret() {
		let edit = MarkdownFormatting.apply(.bold, to: "ab", selection: 1..<1)
		#expect(edit.text == "a****b")
		#expect(edit.selection == 3..<3)
	}

	@Test func boldTogglesOffWhenMarkersSurroundTheSelection() {
		let edit = MarkdownFormatting.apply(.bold, to: "a **b** c", selection: 4..<5)
		#expect(edit.text == "a b c")
		#expect(edit.selection == 2..<3)
	}

	@Test func italicTogglesOffWhenSelectionIncludesMarkers() {
		let edit = MarkdownFormatting.apply(.italic, to: "a _b_ c", selection: 2..<5)
		#expect(edit.text == "a b c")
		#expect(edit.selection == 2..<3)
	}

	@Test func linkWrapsSelectionAndSelectsTheUrlPlaceholder() {
		let edit = MarkdownFormatting.apply(.link, to: "see docs", selection: 4..<8)
		#expect(edit.text == "see [docs](url)")
		#expect(edit.selection == 11..<14)
	}

	@Test func linkAtCaretInsertsAPlaceholderLink() {
		let edit = MarkdownFormatting.apply(.link, to: "", selection: 0..<0)
		#expect(edit.text == "[text](url)")
	}

	@Test func bulletPrefixesEachSelectedLine() {
		let edit = MarkdownFormatting.apply(.bullet, to: "one\ntwo\nthree", selection: 0..<7)
		#expect(edit.text == "- one\n- two\nthree")
	}

	@Test func bulletTogglesOffWhenEveryLineHasIt() {
		let edit = MarkdownFormatting.apply(.bullet, to: "- one\n- two", selection: 0..<11)
		#expect(edit.text == "one\ntwo")
	}

	@Test func headingPrefixesTheCaretLine() {
		let edit = MarkdownFormatting.apply(.heading, to: "intro\ntitle", selection: 8..<8)
		#expect(edit.text == "intro\n## title")
		#expect(edit.selection == 11..<11)
	}

	@Test func outOfRangeSelectionIsClamped() {
		let edit = MarkdownFormatting.apply(.bold, to: "hi", selection: 5..<9)
		#expect(edit.text == "hi****")
	}
}
