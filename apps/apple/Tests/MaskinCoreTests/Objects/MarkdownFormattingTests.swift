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

@Suite("MarkdownFormatting chat formats") struct MarkdownChatFormattingTests {
	private func apply(_ format: MarkdownFormat, _ text: String, _ selection: Range<Int>) -> (String, Range<Int>) {
		let edit = MarkdownFormatting.apply(format, to: text, selection: selection)
		return (edit.text, edit.selection)
	}

	@Test func strikethroughAndInlineCodeToggle() {
		#expect(apply(.strikethrough, "old text", 0..<3) == ("~~old~~ text", 2..<5))
		#expect(apply(.strikethrough, "~~old~~ text", 2..<5) == ("old text", 0..<3))
		#expect(apply(.code, "run make now", 4..<8) == ("run `make` now", 5..<9))
		#expect(apply(.code, "run `make` now", 5..<9) == ("run make now", 4..<8))
	}

	@Test func aCaretWithNothingSelectedLeavesEmptyMarkers() {
		#expect(apply(.code, "", 0..<0) == ("``", 1..<1))
	}

	@Test func numberedListAndQuotePrefixEachSelectedLine() {
		#expect(apply(.numbered, "one\ntwo", 0..<7) == ("1. one\n1. two", 3..<13))
		#expect(apply(.quote, "said this", 0..<9) == ("> said this", 2..<11))
		#expect(apply(.quote, "> said this", 2..<11) == ("said this", 0..<9))
	}

	@Test func codeBlockFencesTheSelectionOnItsOwnLines() {
		#expect(apply(.codeBlock, "let x = 1", 0..<9) == ("```\nlet x = 1\n```", 4..<13))
		// Mid-line: the fences start and end on their own lines.
		#expect(apply(.codeBlock, "see x here", 4..<5) == ("see \n```\nx\n```\n here", 9..<10))
	}

	@Test func codeBlockWithNothingSelectedOpensAnEmptyBlockAndRemovesFences() {
		#expect(apply(.codeBlock, "", 0..<0) == ("```\n\n```", 4..<4))
		#expect(apply(.codeBlock, "```\nlet x = 1\n```", 4..<13) == ("let x = 1", 0..<9))
	}
}
