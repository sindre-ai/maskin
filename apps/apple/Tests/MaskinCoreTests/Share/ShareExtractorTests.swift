import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import MaskinCore

@Suite("ShareExtractor")
struct ShareExtractorTests {
	private let scratch = ShareScratch()
	private func extractor(maxAttachments: Int = 5, maxFileBytes: Int = 1024) -> ShareExtractor {
		ShareExtractor(
			workDirectory: scratch.url.appendingPathComponent("work"), maxAttachments: maxAttachments,
			maxFileBytes: maxFileBytes)
	}

	@Test("a web page: URL plus the title the host app offered")
	func webPage() async {
		let content = await extractor().extract(
			from: [.link("https://example.com/a")], context: ShareContext(title: "  Example page "))
		#expect(content.link == URL(string: "https://example.com/a"))
		#expect(content.linkTitle == "Example page")
		#expect(content.attachments.isEmpty)
	}

	@Test("a context title that is just the address is not a title")
	func titleIsAddress() async {
		let content = await extractor().extract(
			from: [.link("https://example.com/a")], context: ShareContext(title: "https://example.com/a"))
		#expect(content.linkTitle == nil)
	}

	@Test("a string that is one web address is a link, not text")
	func bareAddressText() async {
		let content = await extractor().extract(from: [.text(" https://example.com/x \n")])
		#expect(content.link == URL(string: "https://example.com/x"))
		#expect(content.text == nil)
	}

	@Test("a sentence containing an address stays text")
	func sentenceIsText() async {
		let content = await extractor().extract(from: [.text("see https://example.com/x for more")])
		#expect(content.link == nil)
		#expect(content.text == "see https://example.com/x for more")
	}

	@Test("a non-web URL (mailto, custom scheme) is kept as text rather than a link")
	func nonWebURL() async {
		let content = await extractor().extract(from: [.link("mailto:a@example.com")])
		#expect(content.link == nil)
		#expect(content.text == "mailto:a@example.com")
	}

	@Test("a second web address does not replace the first link")
	func secondLink() async {
		let content = await extractor().extract(from: [.link("https://a.example"), .link("https://b.example")])
		#expect(content.link == URL(string: "https://a.example"))
		#expect(content.text == "https://b.example")
	}

	@Test("selected text next to a link keeps both; text equal to the title is dropped")
	func textAndLink() async {
		let both = await extractor().extract(
			from: [.link("https://example.com"), .text("the quote")], context: ShareContext(title: "T"))
		#expect(both.link != nil && both.text == "the quote")
		let dup = await extractor().extract(
			from: [.link("https://example.com"), .text("T")], context: ShareContext(title: "T"))
		#expect(dup.text == nil)
	}

	@Test("a PDF within the cap is staged as a file with its real name and type")
	func pdf() async throws {
		let file = scratch.file("source.pdf", bytes: 200)
		let content = await extractor().extract(from: [.pdf(file, name: "Brief.pdf")])
		let a = try #require(content.attachments.first)
		#expect(a.kind == .pdf && a.name == "Brief.pdf" && a.mimeType == "application/pdf" && a.sizeBytes == 200)
		#expect(FileManager.default.fileExists(atPath: a.fileURL.path))
		#expect(a.fileURL != file)
	}

	@Test("a file over the cap is skipped with a reason, never staged")
	func tooLarge() async {
		let file = scratch.file("big.pdf", bytes: 2000)
		let content = await extractor(maxFileBytes: 1024).extract(from: [.pdf(file, name: "Big.pdf")])
		#expect(content.attachments.isEmpty)
		#expect(content.skipped == [ShareSkip(name: "Big.pdf", reason: .tooLarge)])
		#expect(content.skipped[0].message == "Big.pdf is over 10 MB, so it wasn't added.")
	}

	@Test("the real 10 MB cap is the server's: 10 MiB passes, one byte more does not")
	func serverCap() {
		#expect(ShareLimits.maxFileBytes == 10 * 1024 * 1024)
	}

	@Test("an unreadable item is skipped, and the rest of the share still goes through")
	func unreadableDoesNotSinkTheShare() async {
		let broken = ShareFakeSource(typeIdentifiers: [UTType.pdf.identifier], suggestedName: "Gone.pdf", file: nil)
		let content = await extractor().extract(from: [broken, .text("still here")])
		#expect(content.skipped == [ShareSkip(name: "Gone.pdf", reason: .unreadable)])
		#expect(content.text == "still here")
	}

	@Test("more items than the cap: the first ones are kept and one note says so")
	func overLimit() async {
		let files = (0..<4).map { scratch.file("f\($0).pdf", bytes: 10) }
		let content = await extractor(maxAttachments: 2).extract(from: files.map { .pdf($0, name: "f.pdf") })
		#expect(content.attachments.count == 2)
		#expect(content.skipped.filter { $0.reason == .overLimit }.count == 1)
	}

	@Test("an unknown type is reported, not silently dropped")
	func unsupported() async {
		let odd = ShareFakeSource(typeIdentifiers: ["com.example.nothing"], suggestedName: "Thing")
		let content = await extractor().extract(from: [odd])
		#expect(content.skipped == [ShareSkip(name: "Thing", reason: .unsupported)])
		#expect(content.isEmpty)
	}

	@Test("a file name cannot carry a path or control characters out of the work directory")
	func fileNameSanitised() async throws {
		let file = scratch.file("source.pdf", bytes: 10)
		let content = await extractor().extract(from: [.pdf(file, name: "../../etc/pass\u{0}wd.pdf")])
		let a = try #require(content.attachments.first)
		#expect(a.name == "passwd.pdf")
		#expect(a.fileURL.deletingLastPathComponent().path.hasSuffix("work"))
	}

	@Test("a big photo is downsampled to the long-edge cap, never sent at full size")
	func imageDownsampled() async throws {
		let photo = scratch.image("photo.jpg", width: 4200, height: 3000)
		let content = await extractor(maxFileBytes: 10 * 1024 * 1024).extract(from: [.image(photo, name: "IMG_1.JPG")])
		let a = try #require(content.attachments.first)
		#expect(a.kind == .image && a.mimeType == "image/jpeg" && a.name == "IMG_1.jpg")
		let src = try #require(CGImageSourceCreateWithURL(a.fileURL as CFURL, nil))
		let props = try #require(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
		let w = props[kCGImagePropertyPixelWidth] as? Int ?? 0
		let h = props[kCGImagePropertyPixelHeight] as? Int ?? 0
		#expect(max(w, h) == ShareLimits.maxImagePixels)
		#expect(w > h)
	}

	@Test("a small JPEG is passed through byte for byte")
	func smallImagePassThrough() async throws {
		let photo = scratch.image("small.jpg", width: 300, height: 200)
		let original = try Data(contentsOf: photo)
		let content = await extractor(maxFileBytes: 10 * 1024 * 1024).extract(from: [.image(photo)])
		let a = try #require(content.attachments.first)
		#expect(try Data(contentsOf: a.fileURL) == original)
	}

	@Test("a large PNG stays a PNG so transparency survives")
	func pngStaysPNG() async throws {
		let png = scratch.image("shot.png", width: 3000, height: 2000, type: .png)
		let content = await extractor(maxFileBytes: 10 * 1024 * 1024).extract(
			from: [ShareFakeSource(typeIdentifiers: [UTType.png.identifier], suggestedName: "shot.png", file: png)])
		let a = try #require(content.attachments.first)
		#expect(a.mimeType == "image/png" && a.name.hasSuffix(".png"))
	}

	@Test("a file that is not an image is rejected as unreadable when declared as one")
	func notAnImage() async {
		let junk = scratch.file("junk.jpg", bytes: 100)
		let content = await extractor().extract(from: [.image(junk, name: "junk.jpg")])
		#expect(content.attachments.isEmpty)
		#expect(content.skipped.first?.reason == .unreadable)
	}

	@Test("cleanUp removes every staged file")
	func cleanUp() async throws {
		let file = scratch.file("a.pdf", bytes: 10)
		let content = await extractor().extract(from: [.pdf(file, name: "a.pdf")])
		let staged = try #require(content.attachments.first).fileURL
		content.cleanUp()
		#expect(!FileManager.default.fileExists(atPath: staged.path))
	}
}
