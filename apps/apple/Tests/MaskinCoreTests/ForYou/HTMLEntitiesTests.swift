import Testing

@testable import MaskinCore

@Suite("HTMLEntities")
struct HTMLEntitiesTests {
	@Test("decodes the typographic entities agents write into titles")
	func typographic() {
		#expect(HTMLEntities.decode("Maskin &middot; Market briefing &mdash; now&hellip;") == "Maskin \u{00B7} Market briefing \u{2014} now\u{2026}")
	}

	@Test("decodes decimal and hex numeric entities")
	func numeric() {
		#expect(HTMLEntities.decode("a&#183;b &#x2014; c &#39;d&#39;") == "a\u{00B7}b \u{2014} c 'd'")
	}

	@Test("decodes once, so an escaped entity stays an entity")
	func singlePass() {
		#expect(HTMLEntities.decode("&amp;lt; &amp;middot;") == "&lt; &middot;")
	}

	@Test("leaves unknown entities and bare ampersands alone")
	func unknown() {
		#expect(HTMLEntities.decode("R&D &bogus; &#xZZ; AT&T") == "R&D &bogus; &#xZZ; AT&T")
	}

	@Test("slide text and story headlines both go through it")
	func callSites() {
		#expect(PresentationParser.plain("<p>Maskin &middot; briefing</p>") == "Maskin \u{00B7} briefing")
		#expect(StoryDerivation.headline(html: "<title>Q3 &mdash; plan</title>", fileName: "x.html") == "Q3 \u{2014} plan")
	}
}
