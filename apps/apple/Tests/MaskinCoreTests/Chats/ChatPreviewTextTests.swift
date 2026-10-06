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
