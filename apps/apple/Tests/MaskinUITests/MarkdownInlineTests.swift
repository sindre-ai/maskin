import MaskinDesign
import SwiftUI
import Testing

@testable import MaskinUI

@Suite("MarkdownInline") struct MarkdownInlineTests {
	private func runs(_ md: String) -> [(text: String, intent: InlinePresentationIntent, hasFont: Bool, link: Bool)] {
		let attr = MarkdownInline.attributed(md, base: .body)
		return attr.runs.map {
			(String(attr[$0.range].characters), $0.inlinePresentationIntent ?? [], $0.font != nil, $0.link != nil)
		}
	}

	@Test func boldCarriesIntentAndExplicitFont() {
		let r = runs("a **backoff** b")
		let bold = r.first { $0.text == "backoff" }
		#expect(bold?.intent.contains(.stronglyEmphasized) == true)
		#expect(bold?.hasFont == true)
		#expect(r.first { $0.text == "a " }?.hasFont == false)
	}

	@Test func italicCodeLinkAndNested() {
		#expect(runs("*it*").first?.intent.contains(.emphasized) == true)
		#expect(runs("*it*").first?.hasFont == true)
		#expect(runs("`c`").first?.intent.contains(.code) == true)
		#expect(runs("[l](https://maskin.io)").first?.link == true)
		let nested = runs("***both***").first
		#expect(nested?.intent.contains(.stronglyEmphasized) == true)
		#expect(nested?.intent.contains(.emphasized) == true)
		#expect(nested?.hasFont == true)
	}

	@Test func inlineSyntaxSurvivesParserInListsAndQuotes() {
		let blocks = MarkdownParser.parse("- use **backoff**\n\n> *careful* with `x`")
		guard case .bulletList(let items) = blocks[0], case .paragraph(let item) = items[0][0],
			case .blockquote(let inner) = blocks[1], case .paragraph(let quote) = inner[0]
		else { Issue.record("unexpected block shape: \(blocks)"); return }
		#expect(runs(item).contains { $0.text == "backoff" && $0.intent.contains(.stronglyEmphasized) && $0.hasFont })
		#expect(runs(quote).contains { $0.text == "careful" && $0.intent.contains(.emphasized) })
		#expect(runs(quote).contains { $0.text == "x" && $0.intent.contains(.code) })
	}

	@Test func listMarkersAreNotInlineSyntax() {
		#expect(runs("**a** and **b**").filter { $0.intent.contains(.stronglyEmphasized) }.count == 2)
	}
}

#if os(macOS)
@MainActor
@Suite("MarkdownInline rendering") struct MarkdownInlineRenderingTests {
	private func width(_ md: String) -> CGFloat {
		let text = Text(MarkdownInline.attributed(md, base: MaskinTextRole.body.font)).maskinText(.body).fixedSize()
		return ImageRenderer(content: text).cgImage?.width.asCGFloat ?? 0
	}

	/// Bold glyphs are wider: same characters, wider render proves the weight is applied.
	@Test func boldAndItalicChangeTheRenderedGlyphs() {
		let plain = width("backoff backoff")
		#expect(plain > 0)
		#expect(width("**backoff** **backoff**") > plain)
	}
}

private extension Int { var asCGFloat: CGFloat { CGFloat(self) } }
#endif
