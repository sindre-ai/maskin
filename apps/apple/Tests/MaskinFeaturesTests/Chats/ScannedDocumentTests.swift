import CoreGraphics
import Foundation
import Testing

@testable import MaskinFeatures

#if canImport(UIKit)
import UIKit
#endif

@Suite("ScannedDocument")
struct ScannedDocumentTests {
	@Test("the file name carries the date and time and ends in .pdf")
	func fileName() {
		let zone = TimeZone(identifier: "UTC")!
		let date = Date(timeIntervalSince1970: 1_795_085_100)  // 2026-11-19 10:45 UTC
		#expect(ScannedDocument.fileName(at: date, timeZone: zone) == "Scan 2026-11-19 10.45.pdf")
	}

	@Test("a tall page is fitted to the page box by its height")
	func tallPage() {
		let size = ScannedDocument.pageSize(forImage: CGSize(width: 1500, height: 3960))
		#expect(size.height == 792)
		#expect(abs(size.width - 300) < 0.001)
	}

	@Test("a wide page is fitted to the page box by its width")
	func widePage() {
		let size = ScannedDocument.pageSize(forImage: CGSize(width: 3060, height: 1530))
		#expect(size.width == 612)
		#expect(abs(size.height - 306) < 0.001)
	}

	@Test("an image with no size falls back to the page box")
	func emptyImage() {
		#expect(ScannedDocument.pageSize(forImage: .zero) == ScannedDocument.pageBox)
	}

	#if canImport(UIKit)
	@Test("no pages, no PDF")
	func noPages() {
		#expect(ScannedDocument.pdf(from: []) == nil)
	}

	@Test("three pages make one PDF with three pages")
	func threePages() throws {
		let page = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 300)).image { context in
			UIColor.white.setFill()
			context.fill(CGRect(x: 0, y: 0, width: 200, height: 300))
		}
		let data = try #require(ScannedDocument.pdf(from: [page, page, page]))
		let provider = try #require(CGDataProvider(data: data as CFData))
		let document = try #require(CGPDFDocument(provider))
		#expect(document.numberOfPages == 3)
	}
	#endif
}
