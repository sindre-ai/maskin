import Testing

@testable import MaskinCore

@Suite("SlashPicker")
struct SlashPickerTests {
	@Test("a slash at the start or after a space opens the picker")
	func trigger() {
		#expect(SlashTrigger.find(in: "/")?.query == "")
		#expect(SlashTrigger.find(in: "see /pri")?.query == "pri")
	}

	@Test("a slash inside a word or path does not")
	func notTrigger() {
		#expect(SlashTrigger.find(in: "and/or") == nil)
		#expect(SlashTrigger.find(in: "/pricing page") == nil)
	}

	@Test("matches by title, case-insensitively, capped")
	func matches() {
		let items = (1...8).map { SlashItem(id: "\($0)", title: "Pricing \($0)", typeLabel: "Task") }
			+ [SlashItem(id: "x", title: "Other", typeLabel: "Bet")]
		#expect(SlashReference.matches(items, query: "PRIC").count == 5)
		#expect(SlashReference.matches(items, query: "oth").map(\.id) == ["x"])
		#expect(SlashReference.matches(items, query: "").count == 5)
	}

	@Test("the link keeps the title readable and brackets out of it")
	func markdown() {
		let md = SlashReference.markdown(title: "A [b]", workspaceID: "w", objectID: "o")
		#expect(md.hasPrefix("[A (b)](https://maskin.io/w/objects/o"))
	}

	@Test("picking replaces the typed query with the link")
	@MainActor
	func pick() {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		model.text = "see /pri"
		model.pickSlash(markdown: "[P](u)")
		#expect(model.text == "see [P](u) ")
	}

	@Test("subtitles")
	func subtitle() {
		let item = SlashItem(id: "1", title: "T", typeLabel: "Task")
		#expect(item.subtitle(isRecent: true) == "Task · recent")
		#expect(item.subtitle(isRecent: false) == "Task")
	}
}
