import Testing

@testable import MaskinUI

@Suite("MarkdownParser") struct MarkdownParserTests {
	@Test func headingsAndParagraphs() {
		let blocks = MarkdownParser.parse("# One\n\n### Three ###\nBody line\ncontinues here")
		#expect(blocks == [
			.heading(level: 1, text: "One"),
			.heading(level: 3, text: "Three"),
			.paragraph("Body line continues here"),
		])
	}

	@Test func hashWithoutSpaceIsNotAHeading() {
		#expect(MarkdownParser.parse("#nospace") == [.paragraph("#nospace")])
	}

	@Test func hardBreakKeepsNewline() {
		#expect(MarkdownParser.parse("a  \nb") == [.paragraph("a\nb")])
	}

	@Test func bulletAndOrderedLists() {
		let blocks = MarkdownParser.parse("- a\n- b\n\n3. x\n4. y")
		#expect(blocks == [
			.bulletList([[.paragraph("a")], [.paragraph("b")]]),
			.orderedList(start: 3, items: [[.paragraph("x")], [.paragraph("y")]]),
		])
	}

	@Test func nestedList() {
		let blocks = MarkdownParser.parse("- parent\n  - child\n- next")
		#expect(blocks == [
			.bulletList([
				[.paragraph("parent"), .bulletList([[.paragraph("child")]])],
				[.paragraph("next")],
			])
		])
	}

	@Test func fencedCodeKeepsContentVerbatim() {
		let blocks = MarkdownParser.parse("```swift\nlet a = 1\n\n# not a heading\n```\nafter")
		#expect(blocks == [
			.codeBlock(language: "swift", code: "let a = 1\n\n# not a heading"),
			.paragraph("after"),
		])
	}

	@Test func unterminatedFenceRunsToEnd() {
		#expect(MarkdownParser.parse("```\nx\ny") == [.codeBlock(language: nil, code: "x\ny")])
	}

	@Test func blockquoteRecurses() {
		let blocks = MarkdownParser.parse("> quote\n> - item")
		#expect(blocks == [.blockquote([.paragraph("quote"), .bulletList([[.paragraph("item")]])])])
	}

	@Test func thematicBreakIsNotAList() {
		#expect(MarkdownParser.parse("---") == [.thematicBreak])
		#expect(MarkdownParser.parse("* * *") == [.thematicBreak])
	}

	@Test func emptyInputYieldsNoBlocks() {
		#expect(MarkdownParser.parse("").isEmpty)
		#expect(MarkdownParser.parse("\n\n  \n").isEmpty)
	}

	@Test func windowsLineEndings() {
		#expect(MarkdownParser.parse("# T\r\n\r\ntext") == [.heading(level: 1, text: "T"), .paragraph("text")])
	}

	@Test func inlineSyntaxStaysInText() {
		#expect(MarkdownParser.parse("**bold** and `code`") == [.paragraph("**bold** and `code`")])
	}
}
