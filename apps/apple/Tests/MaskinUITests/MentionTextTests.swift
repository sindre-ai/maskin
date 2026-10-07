import MaskinDesign
import SwiftUI
import Testing

@testable import MaskinUI

@Suite("MentionText")
struct MentionTextTests {
	private func tagged(_ text: String, _ names: [String]) -> [String] {
		MentionText.ranges(in: text, names: names).map { String(text[$0]) }
	}

	@Test("tags the first name and the full name, preferring the longer one")
	func names() {
		#expect(tagged("ask @Ida to look", ["Ida Berg"]) == ["@Ida"])
		#expect(tagged("ask @Ida Berg to look", ["Ida Berg"]) == ["@Ida Berg"])
	}

	@Test("ignores case, and anything that tags no one")
	func ignores() {
		#expect(tagged("hi @ida", ["Ida Berg"]) == ["@ida"])
		#expect(tagged("mail me@ida.com", ["Ida Berg"]).isEmpty)
		#expect(tagged("hi @Idaho", ["Ida Berg"]).isEmpty)
		#expect(tagged("hi @Sam", ["Ida Berg"]).isEmpty)
		#expect(tagged("hi @Ida", []).isEmpty)
	}

	@Test("names the tagged people whose tag the text does not show")
	func untagged() {
		#expect(MentionText.untagged(["Ida Berg", "CPO"], in: "ask @Ida and @CPO") == [])
		#expect(MentionText.untagged(["Ida Berg", "CPO"], in: "ask @Ida") == ["CPO"])
		#expect(MentionText.untagged(["Ida Berg"], in: "no tags here") == ["Ida Berg"])
	}

	@Test("finds several tags, and a tag at the very end")
	func several() {
		#expect(tagged("@Ida and @CPO", ["Ida Berg", "CPO"]) == ["@Ida", "@CPO"])
	}

	@Test("bolds exactly the tagged name")
	func attributed() {
		let result = MentionText.attributed("ask @Ida now", names: ["Ida Berg"])
		let runs = result.runs.filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
		#expect(runs.map { String(result[$0.range].characters) } == ["@Ida"])
	}

	@Test("rewrites tags as mention links for the markdown renderer")
	func markdown() {
		let md = MentionText.markdown("ask @Ida and @CPO", mentions: [("i", "Ida Berg"), ("c", "CPO")])
		#expect(md == "ask [@Ida](mention:i) and [@CPO](mention:c)")
		#expect(MentionText.markdown("hi @Sam", mentions: [("i", "Ida Berg")]) == "hi @Sam")
	}
}

@Suite("MentionText colours")
struct MentionTextColourTests {
	@Test("a mention is Patina text on a plain surface and soft grey in your own ink bubble")
	func styleColours() {
		#expect(MentionText.Style.plain.color == MaskinColor.sigInk)
		#expect(MentionText.Style.ownBubble.color == MaskinPatina.mentionOnInverse)
	}
}
