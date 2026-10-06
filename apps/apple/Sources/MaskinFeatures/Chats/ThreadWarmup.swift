import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The first thread opened after launch pays for one-time setup: Foundation's markdown parser, the
/// regexes and link detector behind message formatting, and the first font lookup. Running each
/// once, off the main thread, at launch means that cost is not a blank second on the first open.
enum ThreadWarmup {
	static func run() {
		Task.detached(priority: .utility) {
			_ = try? AttributedString(
				markdown: "**a** `b` [c](https://example.com)",
				options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
			_ = MarkdownParser.parse("# a\n\n- b\n\n| a |\n|---|\n| 1 |\n\n```swift\nlet x = 1\n```")
			_ = MarkdownStandaloneLink.match("[a](https://maskin.io/x)")
			_ = SyntaxHighlighter.attributed("let x = \"a\" // b", language: "swift")
			_ = ChatPreviewText.plain("**a** [b](https://x.io)")
			_ = MaskinTypeface.isAvailable(MaskinTypeface.sansFamily)
			_ = MaskinTypeface.isAvailable(MaskinTypeface.monoFamily)
		}
	}
}
