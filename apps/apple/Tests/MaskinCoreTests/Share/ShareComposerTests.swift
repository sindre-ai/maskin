import Foundation
import Testing

@testable import MaskinCore

@Suite("ShareComposer")
struct ShareComposerTests {
	private let url = URL(string: "https://example.com/post")!

	@Test("a link with a title becomes a markdown link under the note")
	func linkWithNote() {
		let content = ShareContent(link: url, linkTitle: "A post")
		#expect(
			ShareComposer.objectContent(note: "  worth a look ", content: content)
				== "worth a look\n\n[A post](https://example.com/post)")
	}

	@Test("a link with no title is an autolink, not an empty label")
	func bareLink() {
		#expect(ShareComposer.objectContent(note: "", content: ShareContent(link: url)) == "<https://example.com/post>")
	}

	@Test("a title that is the address itself does not repeat it")
	func titleEqualsAddress() {
		let content = ShareContent(link: url, linkTitle: url.absoluteString)
		#expect(ShareComposer.objectContent(note: "", content: content) == "<https://example.com/post>")
	}

	@Test("brackets in a page title cannot end the markdown label early")
	func bracketsInTitle() {
		let content = ShareContent(link: url, linkTitle: "[Draft] plan")
		#expect(ShareComposer.objectContent(note: "", content: content) == "[(Draft) plan](https://example.com/post)")
	}

	@Test("text alone is the body as written")
	func textAlone() {
		#expect(ShareComposer.objectContent(note: "", content: ShareContent(text: "Line one\nLine two")) == "Line one\nLine two")
	}

	@Test("text next to a note or a link is quoted line by line")
	func textQuoted() {
		let withNote = ShareContent(text: "a\n\nb")
		#expect(ShareComposer.objectContent(note: "mine", content: withNote) == "mine\n\n> a\n> \n> b")
		let withLink = ShareContent(link: url, linkTitle: "T", text: "quote")
		#expect(ShareComposer.objectContent(note: "", content: withLink) == "[T](https://example.com/post)\n\n> quote")
	}

	@Test("the user's title wins; an empty one falls back to the suggestion; both are capped")
	func titles() {
		let content = ShareContent(link: url, linkTitle: "Page title")
		#expect(ShareComposer.objectTitle("  Mine ", content: content) == "Mine")
		#expect(ShareComposer.objectTitle("   ", content: content) == "Page title")
		let long = String(repeating: "x", count: 500)
		#expect(ShareComposer.objectTitle(long, content: content).count == ShareLimits.maxTitleCharacters)
	}

	@Test("suggested title: page title, else first line of text, else file stem, else host")
	func suggestedTitle() {
		#expect(ShareContent(link: url, linkTitle: "T", text: "x").suggestedTitle == "T")
		#expect(ShareContent(text: "\n  First line \nSecond").suggestedTitle == "First line")
		let file = ShareAttachment(kind: .pdf, name: "Q3 plan.pdf", mimeType: "application/pdf", fileURL: url, sizeBytes: 1)
		#expect(ShareContent(attachments: [file]).suggestedTitle == "Q3 plan")
		#expect(ShareContent(link: url).suggestedTitle == "example.com")
		#expect(ShareContent().suggestedTitle == "")
	}
}
