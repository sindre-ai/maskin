import Foundation
import Testing

@testable import MaskinCore

@Suite("Presentation slides")
struct PresentationSlidesTests {
	private let html = """
		<html><head><style>.x{}</style><script>var a=1</script></head><body>
		<section><h1>Where we are</h1><p>Outreach is on track this week.</p></section>
		<section><div class="stat">47</div><p>contacts reviewed</p></section>
		<section><ul><li>Replies 18%</li><li>Opens 42%</li><li>Bounces 3%</li></ul></section>
		<section><p>Next step</p><a href="#">Review Northwind</a></section>
		</body></html>
		"""

	@Test("each section becomes a card with the right kind")
	func kinds() {
		let slides = PresentationParser.parse(html: html)
		#expect(slides.count == 4)
		#expect(slides[0].kind == .text)
		#expect(slides[1].kind == .stat(big: "47"))
		if case .bars(let bars) = slides[2].kind {
			#expect(bars.map(\.label) == ["Replies", "Opens", "Bounces"])
			#expect(bars[0].fraction == 0.18)
		} else {
			Issue.record("expected bars")
		}
		#expect(slides[3].kind == .cta(action: "Review Northwind"))
	}

	@Test("scripts and styles never become text")
	func ignoresCode() {
		#expect(!PresentationParser.parse(html: html).contains { $0.text.contains("var a") })
	}

	@Test("text is cut to 25 words and a deck to 8 cards")
	func limits() {
		let long = (1...40).map { "w\($0)" }.joined(separator: " ")
		let slide = PresentationParser.parse(html: "<p>\(long)</p>")[0]
		#expect(slide.text.split(separator: " ").count == 25)
		let many = (1...12).map { "<section><p>Card \($0)</p></section>" }.joined()
		#expect(PresentationParser.parse(html: many).count == 8)
	}

	@Test("a page without sections splits on headings")
	func headings() {
		let slides = PresentationParser.parse(html: "<h1>One</h1><p>a</p><h2>Two</h2><p>b</p>")
		#expect(slides.count == 2)
	}

	@Test("summary reads cards and clock")
	func summary() {
		let slides = PresentationParser.parse(html: html)
		#expect(PresentationParser.summary(of: slides) == "4 cards \u{00B7} 0:40")
	}

	@Test("a deck trimmed by the cap says how many cards the page holds")
	func trimmedSummary() {
		let many = (1...18).map { "<section><p>Card \($0)</p></section>" }.joined()
		let slides = PresentationParser.parse(html: many)
		#expect(PresentationParser.totalCount(html: many) == 18)
		#expect(PresentationParser.summary(of: slides, total: 18) == "8 of 18 cards \u{00B7} 1:20")
		#expect(PresentationParser.summary(of: slides, total: 8) == "8 cards \u{00B7} 1:20")
	}

	@Test("type labels use the schema name and never say Loop")
	func typeLabels() {
		#expect(ForYouTypeLabel.label(for: "loop") == "Flow")
		#expect(ForYouTypeLabel.label(for: "meeting_note") == "Meeting Note")
		#expect(ForYouTypeLabel.label(for: "bet", displayNames: ["bet": "Wager"]) == "Wager")
		#expect(ForYouTypeLabel.label(for: "x", displayNames: ["x": "Loop item"]) == "Flow item")
	}
}
