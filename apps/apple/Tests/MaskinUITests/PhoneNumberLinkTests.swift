import Foundation
import SwiftUI
import Testing

@testable import MaskinUI

@Suite("Phone number links") struct PhoneNumberLinkTests {
	/// The text that became a `tel:` link, in order.
	private func linked(_ markdown: String) -> [(text: String, url: String)] {
		let attr = MarkdownInline.attributed(markdown, base: .body)
		return attr.runs.compactMap { run in
			guard let link = run.link, link.scheme == "tel" else { return nil }
			return (String(attr[run.range].characters), link.absoluteString)
		}
	}

	@Test func aDanishNumberWithACountryCodeIsALink() {
		let result = linked("Ring til Jens på +45 12 34 56 78 i dag")
		#expect(result.count == 1)
		#expect(result.first?.text == "+45 12 34 56 78")
		#expect(result.first?.url == "tel:+4512345678")
	}

	@Test func spacesAndDashesAreKeptInTheTextAndDroppedFromTheLink() {
		let result = linked("Call +45 12-34-56-78.")
		#expect(result.first?.url == "tel:+4512345678")
		#expect(result.first?.text == "+45 12-34-56-78")
	}

	@Test func aNumberWithACountryCodeAndNoSpacesIsALink() {
		#expect(linked("Ring +4512345678 nu").first?.url == "tel:+4512345678")
	}

	@Test func aShortNumberIsNotALink() {
		#expect(linked("Dial 112 or 1234567 now").isEmpty)
	}

	@Test("dates and times are not links", arguments: [
		"Due 2026-11-04", "Created 2026-11-04 10:31:36", "Sent 04.11.2026", "At 2026-11-04T10:31:36Z",
	])
	func datesAreNotLinks(text: String) {
		#expect(linked(text).isEmpty)
	}

	@Test func aUnixTimestampIsNotALink() {
		#expect(linked("ts 1730718000 and 1730718000123").isEmpty)
	}

	@Test func aUuidIsNotALink() {
		#expect(linked("id 550e8400-e29b-41d4-a716-446655440000 here").isEmpty)
		#expect(linked("object dd38f6bb-0800-4822-bba3-c67e6598a38a").isEmpty)
	}

	@Test func aNumberInInlineCodeIsNotALink() {
		#expect(linked("use `+45 12 34 56 78` as the key").isEmpty)
	}

	@Test func aNumberInACodeBlockIsNotALink() {
		// Fenced code never goes through the inline renderer: it is its own block.
		let blocks = MarkdownParser.parse("```\n+45 12 34 56 78\n```")
		guard case .codeBlock(_, let code) = blocks[0] else { Issue.record("expected a code block: \(blocks)"); return }
		#expect(code.contains("+45 12 34 56 78"))
		#expect(blocks.count == 1)
	}

	@Test func anExistingMarkdownLinkIsLeftAlone() {
		let attr = MarkdownInline.attributed("[+45 12 34 56 78](https://maskin.io/call)", base: .body)
		let links = attr.runs.compactMap { $0.link?.absoluteString }
		#expect(links == ["https://maskin.io/call"])
		#expect(linked("[+45 12 34 56 78](https://maskin.io/call)").isEmpty)
	}

	@Test func anAuthorsTelLinkIsDroppedButItsVisibleNumberStillLinks() {
		// The target the author hid is never trusted: only the number the reader can see becomes the link.
		#expect(linked("[call me](tel:+4587654321)").isEmpty)
		#expect(linked("[+45 12 34 56 78](tel:+4587654321)").map(\.url) == ["tel:+4512345678"])
	}

	@Test func twoNumbersBecomeTwoLinks() {
		#expect(linked("+45 12 34 56 78 or +45 87 65 43 21").map(\.url) == ["tel:+4512345678", "tel:+4587654321"])
	}

	@Test func textWithoutDigitsIsUntouched() {
		#expect(linked("No numbers here, just words.").isEmpty)
	}

	@Test func dialStringKeepsOnlyDigitsAndALeadingPlus() {
		#expect(PhoneNumberLink.url(for: "+45 (12) 34-56 78")?.absoluteString == "tel:+4512345678")
		#expect(PhoneNumberLink.url(for: "no digits") == nil)
		#expect(PhoneNumberLink.dialString(of: URL(string: "tel:+4512345678")!) == "+4512345678")
	}
}
