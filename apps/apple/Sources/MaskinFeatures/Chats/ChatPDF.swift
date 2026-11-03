import Foundation

#if os(iOS)
import UIKit

/// The chat as a PDF for reading: the title, then each message under its author, on A4 pages. Made
/// locally from the same text as the Markdown export, so cards and transcripts read the same.
enum ChatPDF {
	private static let page = CGRect(x: 0, y: 0, width: 595, height: 842)
	private static let margin: CGFloat = 48

	static func render(title: String, messages: [ChatMessageLine]) -> URL? {
		let body = NSMutableAttributedString()
		let head = NSMutableParagraphStyle()
		head.paragraphSpacing = 14
		body.append(
			NSAttributedString(
				string: (title.isEmpty ? "Chat" : title) + "\n",
				attributes: [.font: UIFont.systemFont(ofSize: 22, weight: .semibold), .paragraphStyle: head]))
		for line in messages {
			body.append(
				NSAttributedString(
					string: line.header + "\n",
					attributes: [
						.font: UIFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: UIColor.darkGray,
					]))
			let para = NSMutableParagraphStyle()
			para.paragraphSpacing = 12
			body.append(
				NSAttributedString(
					string: line.text + "\n",
					attributes: [.font: UIFont.systemFont(ofSize: 13), .paragraphStyle: para]))
		}
		let url = FileManager.default.temporaryDirectory
			.appendingPathComponent((title.isEmpty ? "Chat" : title).replacingOccurrences(of: "/", with: "-"))
			.appendingPathExtension("pdf")
		let renderer = UIGraphicsPDFRenderer(bounds: page)
		let setter = CTFramesetterCreateWithAttributedString(body)
		var location = 0
		do {
			try renderer.writePDF(to: url) { context in
				repeat {
					context.beginPage()
					let cg = context.cgContext
					cg.textMatrix = .identity
					cg.translateBy(x: 0, y: page.height)
					cg.scaleBy(x: 1, y: -1)
					let frameRect = CGRect(
						x: margin, y: margin, width: page.width - margin * 2, height: page.height - margin * 2)
					let frame = CTFramesetterCreateFrame(
						setter, CFRange(location: location, length: 0), CGPath(rect: frameRect, transform: nil), nil)
					CTFrameDraw(frame, cg)
					let shown = CTFrameGetVisibleStringRange(frame)
					if shown.length == 0 { break }
					location += shown.length
				} while location < body.length
			}
			return url
		} catch {
			return nil
		}
	}
}

/// One message as the PDF prints it.
struct ChatMessageLine {
	var header: String
	var text: String
}
#endif
