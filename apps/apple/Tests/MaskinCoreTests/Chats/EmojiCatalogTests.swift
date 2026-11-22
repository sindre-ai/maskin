import Testing

@testable import MaskinCore

@MainActor
@Suite("Emoji list matches the web") struct EmojiCatalogTests {
	@Test func typingSmiOffersTheWebRowsInTheWebOrder() {
		#expect(
			EmojiShortcodes.suggestions(for: "smi").map(\.name)
				== ["smile", "smiley", "slightly_smiling_face", "sweat_smile"])
		#expect(EmojiShortcodes.suggestions(for: "smi").first?.emoji == "😄")
	}

	@Test func searchWordsFindAnEmojiAfterNameMatches() {
		#expect(EmojiShortcodes.suggestions(for: "lol").map(\.name) == ["joy", "rofl"])
		#expect(EmojiShortcodes.suggestions(for: "+1").map(\.name) == ["thumbsup"])
	}

	@Test func namesThatContainTheQueryComeAfterNamesThatStartWithIt() {
		let names = EmojiShortcodes.suggestions(for: "eye", limit: 20).map(\.name)
		#expect(names.first == "eyes")
		#expect(names.contains("heart_eyes"))
		#expect(names.firstIndex(of: "eyes")! < names.firstIndex(of: "heart_eyes")!)
	}

	@Test func theListNeedsTwoCharactersAndHonoursTheLimit() {
		#expect(EmojiShortcodes.suggestions(for: "s").isEmpty)
		#expect(EmojiShortcodes.suggestions(for: "SM", limit: 2).count == 2)
	}

	@Test func everyNameIsUniqueAndTypeable() {
		let names = EmojiShortcodes.catalog.map(\.name)
		#expect(Set(names).count == names.count)
		#expect(names.allSatisfy { !$0.isEmpty && $0 == $0.lowercased() && !$0.contains(" ") })
	}

	@Test func aTypedColonWordPickedFromTheListIsSent() {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		model.text = "great :smi"
		let match = EmojiTrigger.find(in: model.text)
		#expect(match?.query == "smi")
		let first = EmojiShortcodes.suggestions(for: match?.query ?? "", limit: 5).first
		model.pickEmoji(first?.emoji ?? "")
		#expect(model.text == "great 😄")
		#expect(model.take()?.text == "great 😄")
	}

	@Test func fullyTypedShortcodesStillExpandWebNamesFirst() {
		#expect(EmojiShortcodes.expand(":thumbsup: :+1:") == "👍 👍")
		#expect(EmojiShortcodes.expand(":cake:") == "🍰")
		#expect(EmojiShortcodes.expand(":salute:") == "🫡")
	}
}
