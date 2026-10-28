import Testing

@testable import MaskinCore

@Suite("ChatPreviewText") struct ChatPreviewTextTests {
	@Test(
		"markdown becomes plain words",
		arguments: [
			// From the chat list in the app: raw markdown leaked into previews.
			("Nice, thanks. I've marked [the post](https://maskin.io/e2877abc) as live", "Nice, thanks. I've marked the post as live"),
			("Yes — **v10 landed** at 07:17", "Yes — v10 landed at 07:17"),
			("# product video", "product video"),
			("## Get started\n\nThen go on", "Get started Then go on"),
			("- first\n- second", "first second"),
			("1. one\n2) two", "one two"),
			("- [x] done\n- [ ] todo", "done todo"),
			("> quoted words", "quoted words"),
			("use `pnpm test` here", "use pnpm test here"),
			("~~old~~ new", "old new"),
			("an *italic* and _also_ word", "an italic and also word"),
			("![diagram](https://x.io/a.png) shown", "diagram shown"),
			("```swift\nlet x = 1\n```", "let x = 1"),
			("line one\n\n  line two\t end", "line one line two end"),
			("| a | b |\n|---|---|\n| 1 | 2 |", "a · b · 1 · 2"),
		])
	func stripsMarkdown(input: String, expected: String) {
		#expect(ChatPreviewText.plain(input) == expected)
	}

	@Test("ordinary text, snake_case words and math are left alone")
	func leavesPlainTextAlone() {
		#expect(ChatPreviewText.plain("Got it. Personal bots are in the market") == "Got it. Personal bots are in the market")
		#expect(ChatPreviewText.plain("set max_retry_count to 3") == "set max_retry_count to 3")
		#expect(ChatPreviewText.plain("2 * 3 * 4 = 24") == "2 * 3 * 4 = 24")
		#expect(ChatPreviewText.plain("") == "")
		#expect(ChatPreviewText.plain("   ") == "")
	}

	@Test("a bare address stays so the row still says what was sent")
	func keepsBareAddresses() {
		#expect(ChatPreviewText.plain("see https://maskin.io/ws/objects/abc") == "see https://maskin.io/ws/objects/abc")
	}
}

@Suite("ChatPreviewText list line") struct ChatPreviewTextLinePiecesTests {
	private typealias Piece = ChatPreviewText.Piece

	@Test(
		"a link cut short shows its words, not the bracket text",
		arguments: [
			("see [Chat preview cards for every li", "see Chat preview cards for every li"),
			("see [Chat preview cards](https://maskin.io/e2877e32-2c11", "see Chat preview cards"),
			("see [Chat preview cards](", "see Chat preview cards"),
			("see [Chat preview cards]", "see [Chat preview cards]"),
			("a [whole](https://x.io) and [cut](https://x.io/a", "a whole and cut"),
			("![diagram](https://x.io/a.p", "diagram"),
		])
	func cutLinks(input: String, expected: String) {
		#expect(ChatPreviewText.plain(input) == expected)
		#expect(ChatPreviewText.linePieces(input) == [Piece(expected)])
	}

	@Test("a task checkbox is not a cut link")
	func checkboxIsKept() {
		#expect(ChatPreviewText.plain("- [ ] todo") == "todo")
		#expect(ChatPreviewText.linePieces("- [x] done\n- [ ] todo") == [Piece("done todo")])
	}

	@Test("a bare address becomes the word link, marked so the row can mute it")
	func bareAddress() {
		#expect(
			ChatPreviewText.linePieces("https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/abc")
				== [Piece("link", isLink: true)])
		#expect(
			ChatPreviewText.linePieces("see https://maskin.io/ws/objects/abc.")
				== [Piece("see "), Piece("link", isLink: true), Piece(".")])
		#expect(
			ChatPreviewText.linePieces("<https://x.io/a> and maskin://objects/1 now")
				== [Piece("link", isLink: true), Piece(" and "), Piece("link", isLink: true), Piece(" now")])
		#expect(ChatPreviewText.linePieces("cut https://maskin.io/e2877e32-2c") == [Piece("cut "), Piece("link", isLink: true)])
	}

	@Test("a link with words keeps its words, even next to a bare address")
	func wordsBeatAddress() {
		#expect(
			ChatPreviewText.linePieces("[the post](https://maskin.io/ws/objects/abc) https://x.io")
				== [Piece("the post "), Piece("link", isLink: true)])
	}

	@Test("plain text has no link runs, and an empty line has no pieces")
	func plainText() {
		#expect(ChatPreviewText.linePieces("Got it") == [Piece("Got it")])
		#expect(ChatPreviewText.linePieces("") == [])
		#expect(ChatPreviewText.linePieces("   ") == [])
	}
}
