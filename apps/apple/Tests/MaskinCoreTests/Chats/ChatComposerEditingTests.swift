import Testing

@testable import MaskinCore

@MainActor
@Suite("Composer editing, emoji and quotes") struct ChatComposerEditingTests {
	private func model(_ text: String = "") -> ChatComposerModel {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		model.text = text
		return model
	}

	// MARK: Formats and insertion

	@Test func aFormatActsOnTheReportedSelectionAndRequestsItBack() {
		let m = model("make this bold please")
		m.selection = 10..<14
		m.applyFormat(.bold)
		#expect(m.text == "make this **bold** please")
		#expect(m.selection == 12..<16)
		#expect(m.selectionRequest?.range == 12..<16)
	}

	@Test func withNoSelectionAFormatActsAtTheEnd() {
		let m = model("note")
		m.applyFormat(.code)
		#expect(m.text == "note``")
	}

	@Test func insertReplacesTheSelectionAndLeavesTheCaretAfterIt() {
		let m = model("hello world")
		m.selection = 6..<11
		m.insert("👍")
		#expect(m.text == "hello 👍")
		#expect(m.selection == 7..<7)
	}

	@Test func eachRequestHasItsOwnId() {
		let m = model("a")
		m.applyFormat(.bold)
		let first = m.selectionRequest?.id
		m.applyFormat(.bold)
		#expect(m.selectionRequest?.id != first)
	}

	@Test func clearingForgetsTheCaret() {
		let m = model("text")
		m.selection = 1..<2
		m.clear()
		#expect(m.selection == nil && m.selectionRequest == nil && m.text.isEmpty)
	}

	// MARK: Emoji

	@Test func suggestionsPutPrefixMatchesFirst() {
		let names = EmojiShortcodes.suggestions(for: "ta").map(\.name)
		#expect(names.first == "tada")
		#expect(EmojiShortcodes.suggestions(for: "").isEmpty)
		#expect(EmojiShortcodes.suggestions(for: "zzzzzz").isEmpty)
	}

	@Test func theTriggerIsTheColonWordAtTheEnd() {
		#expect(EmojiTrigger.find(in: "nice :tad")?.query == "tad")
		#expect(EmojiTrigger.find(in: ":sm")?.query == "sm")
		#expect(EmojiTrigger.find(in: "at 10:30") == nil)  // colon after a digit, not a trigger
		#expect(EmojiTrigger.find(in: "nice :t") == nil)  // one letter is too early
		#expect(EmojiTrigger.find(in: "nice :tada: ") == nil)
		#expect(EmojiTrigger.find(in: "see :a b") == nil)
	}

	@Test func pickingAnEmojiReplacesTheShortcodeBeingTyped() {
		let m = model("great job :tad")
		m.pickEmoji("🎉")
		#expect(m.text == "great job 🎉")
	}

	@Test func completeShortcodesBecomeEmojiOnSendButCodeAndTimesDoNot() {
		#expect(EmojiShortcodes.expand("ship it :rocket: and :tada:") == "ship it 🚀 and 🎉")
		#expect(EmojiShortcodes.expand("meet at 10:30:45") == "meet at 10:30:45")
		#expect(EmojiShortcodes.expand(":notanemoji: stays") == ":notanemoji: stays")
		#expect(EmojiShortcodes.expand("run `:rocket:` literally") == "run `:rocket:` literally")
		#expect(EmojiShortcodes.expand("```\n:rocket:\n``` then :rocket:") == "```\n:rocket:\n``` then 🚀")
	}

	@Test func takeExpandsShortcodes() {
		let m = model("done :white_check_mark:")
		#expect(m.take()?.text == "done ✅")
	}

	// MARK: Quote

	@Test func aQuoteNamesTheAuthorAndKeepsTheOpeningLines() {
		#expect(
			ChatQuote.make(author: "Relay", content: "First line.\n\nSecond line.")
				== "> **Relay**\n> First line.\n> Second line.\n\n")
	}

	@Test func aLongQuoteIsCutAndMarked() {
		let content = (1...20).map { "line \($0)" }.joined(separator: "\n")
		let quote = ChatQuote.make(author: "Sam", content: content)
		#expect(quote.contains("> line 6…"))
		#expect(!quote.contains("line 7"))
		#expect(ChatQuote.make(author: "Sam", content: "   \n ") == "")
	}

	@Test func quotingSetsTheReplyStripAndSendsTheQuoteAboveTheText() {
		let m = model("my reply")
		m.quote(author: "Relay", content: "Done.")
		#expect(m.text == "my reply", "the draft is untouched; the quote lives in the strip")
		#expect(m.replyTo?.name == "Relay")
		#expect(m.replyTo?.text == "Done.")
		#expect(m.focusRequest == 1)
		m.quote(author: "Relay", content: "")
		#expect(m.replyTo?.text == "Done.", "an empty message cannot be quoted")
		#expect(m.focusRequest == 1)
		let sent = m.take()
		#expect(sent?.text == "> **Relay**\n> Done.\n\nmy reply")
		#expect(m.replyTo == nil)
	}

	@Test func clearQuoteDropsTheReply() {
		let m = model("still here")
		m.reply(to: "Forge", text: "Shipped.")
		m.clearQuote()
		#expect(m.replyTo == nil)
		#expect(m.text == "still here")
	}

	// MARK: Edit

	@Test func beginEditTakesTheMessageTextAndKeepsTheDraft() {
		let m = model("half a thought")
		m.beginEdit(messageID: "42", originalText: "Yes please, flag anything risky.")
		#expect(m.editing?.messageID == "42")
		#expect(m.editing?.originalText == "Yes please, flag anything risky.")
		#expect(m.text == "Yes please, flag anything risky.")
		#expect(m.selectionRequest?.range == 32..<32, "the caret lands at the end")
		#expect(m.focusRequest == 1)
	}

	@Test func cancellingAnEditRestoresTheDraft() {
		let m = model("half a thought")
		m.beginEdit(messageID: "42", originalText: "old text")
		m.text = "old text, revised"
		m.clearQuote()
		#expect(m.editing == nil)
		#expect(m.text == "half a thought")
	}

	@Test func editAndReplyAreExclusive() {
		let m = model("draft")
		m.beginEdit(messageID: "1", originalText: "sent")
		m.reply(to: "Sam", text: "A question")
		#expect(m.editing == nil, "replying ends the edit")
		#expect(m.text == "draft", "and gives the draft back")
		#expect(m.replyTo?.name == "Sam")
		m.beginEdit(messageID: "2", originalText: "other")
		#expect(m.replyTo == nil, "editing ends the reply")
	}

	@Test func takeClearsTheEdit() {
		let m = model()
		m.beginEdit(messageID: "7", originalText: "fix this")
		#expect(m.takeEdit()?.text == "fix this")
		#expect(m.editing == nil)
		#expect(m.text.isEmpty)
	}
}
