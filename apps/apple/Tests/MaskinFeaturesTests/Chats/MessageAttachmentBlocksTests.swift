import Foundation
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import Testing
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

@testable import MaskinFeatures

@Suite("Message attachment layout")
struct MessageAttachmentLayoutTests {
	@Test("a block is 80% of the thread and never wider than 320")
	func widths() {
		#expect(AttachmentLayout.width(thread: 375, fraction: AttachmentLayout.imageFraction) == 300)
		#expect(AttachmentLayout.width(thread: 375, fraction: AttachmentLayout.fileFraction) == 345)
		#expect(AttachmentLayout.width(thread: 402, fraction: AttachmentLayout.fileFraction) == 320)
		#expect(AttachmentLayout.width(thread: 820, fraction: AttachmentLayout.imageFraction) == 320)
		#expect(AttachmentLayout.width(thread: 0, fraction: AttachmentLayout.imageFraction) == 320)
	}

	@Test("one picture keeps its shape between 3:4 and 4:3")
	func single() {
		let landscape = AttachmentLayout.singleSize(ratio: 16.0 / 9.0, width: 320)
		#expect(landscape == CGSize(width: 320, height: 240))
		let portrait = AttachmentLayout.singleSize(ratio: 9.0 / 19.0, width: 320)
		#expect(portrait == CGSize(width: 240, height: 320))
		let square = AttachmentLayout.singleSize(ratio: 1, width: 320)
		#expect(square == CGSize(width: 260, height: 260))
		let narrow = AttachmentLayout.singleSize(ratio: 4.0 / 3.0, width: 200)
		#expect(narrow.width == 200 && narrow.height == 150)
	}

	@Test("two pictures sit side by side in a 2:1 block")
	func two() {
		let frames = AttachmentLayout.tileFrames(count: 2, width: 320)
		#expect(frames == [CGRect(x: 0, y: 0, width: 158, height: 160), CGRect(x: 162, y: 0, width: 158, height: 160)])
		#expect(AttachmentLayout.blockSize(count: 2, width: 320) == CGSize(width: 320, height: 160))
	}

	@Test("three pictures: one large on the left, two stacked on the right")
	func three() {
		let frames = AttachmentLayout.tileFrames(count: 3, width: 320)
		#expect(frames[0] == CGRect(x: 0, y: 0, width: 158, height: 240))
		#expect(frames[1].minX == 162 && frames[2].minX == 162)
		#expect(frames[1].maxY + AttachmentLayout.gap == frames[2].minY)
		#expect(frames[2].maxY == 240)
		#expect(AttachmentLayout.blockSize(count: 3, width: 320) == CGSize(width: 320, height: 240))
	}

	@Test("four or more pictures make a square 2 by 2; the rest is a +N")
	func four() {
		for count in [4, 5, 6, 9] {
			let frames = AttachmentLayout.tileFrames(count: count, width: 320)
			#expect(frames.count == 4)
			#expect(AttachmentLayout.blockSize(count: count, width: 320) == CGSize(width: 320, height: 320))
			#expect(frames[1].minX - frames[0].maxX == AttachmentLayout.gap)
			#expect(frames[2].minY - frames[0].maxY == AttachmentLayout.gap)
		}
		#expect(AttachmentLayout.overflow(4) == 0)
		#expect(AttachmentLayout.overflow(6) == 2)
		#expect(AttachmentLayout.overflow(7) == 3)
	}

	@Test("the file tag names the extension and the size, never pages")
	func fileTag() {
		let pdf = FileTypeTag(name: "Q3-pipeline-review.pdf", mimeType: "application/pdf")
		#expect(pdf.text == "PDF")
		#expect(pdf.meta(sizeBytes: 2_400_000).hasPrefix("PDF · "))
		#expect(!pdf.meta(sizeBytes: 2_400_000).lowercased().contains("page"))
		#expect(FileTypeTag(name: "notes.md", mimeType: "text/markdown").text == "MD")
		#expect(FileTypeTag(name: "model.xlsx", mimeType: nil).text == "XLSX")
		#expect(FileTypeTag(name: "archive.tar", mimeType: nil).text == "TAR")
		#expect(FileTypeTag(name: "scan", mimeType: "application/pdf").text == "PDF")
		#expect(FileTypeTag(name: "README", mimeType: nil).text == "FILE")
		#expect(FileTypeTag(name: "x", mimeType: nil).meta(sizeBytes: nil) == "FILE")
	}

	@Test("a file's transfer maps onto its card state")
	func cardState() {
		#expect(AttachmentFileState(.ready) == .ready)
		#expect(AttachmentFileState(.failed) == .failed)
		#expect(AttachmentFileState(.uploading(progress: 0.4)) == .uploading(progress: 0.4))
	}
}

private let samplePhoto: DecodedImage = {
	let context = CGContext(
		data: nil, width: 600, height: 400, bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
	let colors = [CGColor(red: 0.18, green: 0.45, blue: 0.95, alpha: 1), CGColor(red: 0.62, green: 0.22, blue: 0.85, alpha: 1)]
	let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
	context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 600, y: 400), options: [])
	return DecodedImage(context.makeImage()!)
}()

private func photos(_ count: Int) -> [ChatAttachmentRef] {
	(1...count).map { ChatAttachmentRef(fileID: "img\($0)", name: "photo-\($0).jpg", mimeType: "image/jpeg", sizeBytes: 90_000) }
}

private let pdf = ChatAttachmentRef(fileID: "f1", name: "Q3-pipeline-review.pdf", mimeType: "application/pdf", sizeBytes: 2_400_000)
private let notes = ChatAttachmentRef(fileID: "f2", name: "a-very-long-meeting-notes-file-name-that-has-to-truncate.md", mimeType: "text/markdown", sizeBytes: 4_100)

@MainActor
private func render<V: View>(_ view: V, width: CGFloat, dark: Bool, name: String) throws {
	let framed = view
		.padding(MaskinSpace.s9)
		.frame(width: width, alignment: .trailing)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else {
		Issue.record("ImageRenderer produced no image for \(name)")
		return
	}
	let dir = ProcessInfo.processInfo.environment["CHATS_SNAPSHOT_DIR"] ?? NSTemporaryDirectory() + "chats-snapshots"
	try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	#if canImport(AppKit)
	try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
	#elseif canImport(UIKit)
	try UIImage(cgImage: image).pngData()?.write(to: url)
	#endif
}

@Suite("Message attachment blocks render")
@MainActor
struct MessageAttachmentBlocksSnapshotTests {
	static let widths: [CGFloat] = [375, 430]

	private func stack(_ attachments: [ChatAttachmentRef], width: CGFloat, transfer: AttachmentTransfer = .ready) -> some View {
		MessageAttachments(attachments: attachments, alignment: .trailing, threadWidth: width - 2 * MaskinSpace.s9, transfer: transfer)
			.environment(\.attachmentImages, AttachmentImages(cached: { _ in samplePhoto }, load: { _ in samplePhoto }))
	}

	@Test("picture grids for 1, 2, 3, 4 and 6 pictures", arguments: [false, true])
	func grids(dark: Bool) throws {
		for width in Self.widths {
			for count in [1, 2, 3, 4, 6] {
				try render(stack(photos(count), width: width), width: width, dark: dark, name: "attachments-images-\(count)")
			}
		}
	}

	@Test("picture states: loading, can't load, uploading and failed", arguments: [false, true])
	func pictureStates(dark: Bool) throws {
		let width = Self.widths[0]
		let loading = AttachmentImages(cached: { _ in nil }, load: { _ in try? await Task.sleep(for: .seconds(60)); return nil })
		try render(
			MessageAttachments(attachments: photos(2), alignment: .trailing, threadWidth: width - 2 * MaskinSpace.s9)
				.environment(\.attachmentImages, loading),
			width: width, dark: dark, name: "attachments-images-loading")
		try render(
			MessageAttachments(attachments: photos(2), alignment: .trailing, threadWidth: width - 2 * MaskinSpace.s9)
				.environment(\.attachmentImages, nil),
			width: width, dark: dark, name: "attachments-images-broken")
		try render(
			stack(photos(1), width: width, transfer: .uploading(progress: nil)), width: width, dark: dark,
			name: "attachments-images-uploading")
		try render(stack(photos(4), width: width, transfer: .failed), width: width, dark: dark, name: "attachments-images-failed")
	}

	@Test("file cards in every state", arguments: [false, true])
	func files(dark: Bool) throws {
		let width = Self.widths[0]
		let cards = VStack(alignment: .trailing, spacing: AttachmentLayout.gap) {
			MessageFileCard(file: pdf)
			MessageFileCard(file: notes)
			MessageFileCard(file: pdf, state: .uploading(progress: 0.4))
			MessageFileCard(file: pdf, state: .failed)
			MessageFileCard(file: pdf, state: .gone)
		}
		.frame(width: AttachmentLayout.width(thread: width - 2 * MaskinSpace.s9, fraction: AttachmentLayout.fileFraction))
		try render(cards, width: width, dark: dark, name: "attachments-files")
	}

	@Test("pictures, files and words stack in that order", arguments: [false, true])
	func mixed(dark: Bool) throws {
		let width = Self.widths[0]
		let content = VStack(alignment: .trailing, spacing: AttachmentLayout.gap) {
			stack(photos(1) + [pdf], width: width)
			Text("Here is the screenshot and the brief.").padding().background(MaskinSurface.inverse, in: BubbleShape.mine)
				.foregroundStyle(MaskinSurface.onInverse)
		}
		try render(content, width: width, dark: dark, name: "attachments-mixed")
	}
}
