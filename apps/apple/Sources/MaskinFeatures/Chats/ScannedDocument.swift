import CoreGraphics
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// A scan from the document camera, turned into the one PDF that goes on the message.
enum ScannedDocument {
	/// US Letter in points: a scanned page is fitted inside it, so a 12-megapixel photo does not become a
	/// PDF page several metres wide. Viewers scale pages to the screen, so only the shape matters.
	static let pageBox = CGSize(width: 612, height: 792)

	/// "Scan 2026-11-19 10.45.pdf". Dots, not colons: a colon is not safe in a file name.
	static func fileName(at date: Date, timeZone: TimeZone = .current) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = timeZone
		formatter.dateFormat = "yyyy-MM-dd HH.mm"
		return "Scan \(formatter.string(from: date)).pdf"
	}

	/// The PDF page for an image of this size: the same shape, as large as fits in `pageBox`.
	static func pageSize(forImage size: CGSize) -> CGSize {
		guard size.width > 0, size.height > 0 else { return pageBox }
		let scale = min(pageBox.width / size.width, pageBox.height / size.height)
		return CGSize(width: size.width * scale, height: size.height * scale)
	}

	#if canImport(UIKit)
	/// One PDF with a page per image, in order. Nil when there are no pages or the PDF came out empty.
	static func pdf(from pages: [UIImage]) -> Data? {
		guard let first = pages.first else { return nil }
		let renderer = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: pageSize(forImage: first.size)))
		let data = renderer.pdfData { context in
			for page in pages {
				let rect = CGRect(origin: .zero, size: pageSize(forImage: page.size))
				context.beginPage(withBounds: rect, pageInfo: [:])
				page.draw(in: rect)
			}
		}
		return data.isEmpty ? nil : data
	}
	#endif
}
