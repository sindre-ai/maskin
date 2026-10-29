import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import MaskinCore

private actor RecordingUploader: ChatFileUploading {
	var uploaded: [(name: String, mimeType: String, bytes: Int)] = []

	func upload(name: String, mimeType: String, data: Data) async throws -> ChatAttachmentRef {
		uploaded.append((name, mimeType, data.count))
		return ChatAttachmentRef(fileID: "file-1", name: name, mimeType: mimeType, sizeBytes: data.count)
	}
}

/// A PNG with an alpha channel, like an iPhone screenshot (default size 1179 x 2556 pixels).
private func screenshotPNG(width: Int = 1179, height: Int = 2556) -> Data {
	let space = CGColorSpace(name: CGColorSpace.sRGB)!
	let context = CGContext(
		data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
		bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
	context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
	context.fill(CGRect(x: 0, y: 0, width: width, height: height))
	let out = NSMutableData()
	let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
	CGImageDestinationAddImage(dest, context.makeImage()!, nil)
	CGImageDestinationFinalize(dest)
	return out as Data
}

private func pixelSize(of data: Data) -> (width: Int, height: Int)? {
	guard let source = CGImageSourceCreateWithData(data as CFData, nil),
		let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
		let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int
	else { return nil }
	return (width, height)
}

@Suite("Pasted image")
struct PastedImageTests {
	@Test("the name reads pasted-image-date-time")
	func baseName() {
		let name = PastedImage.baseName(now: Date(timeIntervalSince1970: 1_793_299_512), timeZone: TimeZone(identifier: "UTC")!)
		#expect(name == "pasted-image-2026-10-29-18.45.12")
	}

	@Test("a full-size screenshot is decoded and shrunk to an image the server accepts")
	func screenshot() throws {
		let png = screenshotPNG()
		let file = try PastedImage.prepare(data: png, name: "pasted-image-x")
		#expect(file.name == "pasted-image-x.jpg" || file.name == "pasted-image-x.png")
		#expect(file.mimeType == "image/jpeg" || file.mimeType == "image/png")
		let size = try #require(pixelSize(of: file.data))
		#expect(max(size.width, size.height) <= ImageDownsampler.maxPixelSize)
		#expect(file.data.count <= ChatLimits.maxFileBytes)
	}

	@Test("a small PNG keeps its bytes and its extension")
	func smallPNG() throws {
		let png = screenshotPNG(width: 64, height: 64)
		let file = try PastedImage.prepare(data: png, name: "pasted-image-x.jpg")
		#expect(file.name == "pasted-image-x.png")
		#expect(file.mimeType == "image/png")
		#expect(file.data == png)
	}

	@Test("bytes that are not an image fail with a reason about reading the image")
	func notAnImage() {
		do {
			_ = try PastedImage.prepare(data: Data("hello".utf8), name: "x")
			Issue.record("expected a failure")
		} catch let error as ChatAttachmentError {
			#expect(error.message.hasPrefix("Couldn't read that image"))
		} catch {
			Issue.record("wrong error: \(error)")
		}
	}

	@Test("an empty paste says it was empty")
	func empty() {
		do {
			_ = try PastedImage.prepare(data: Data(), name: "x")
			Issue.record("expected a failure")
		} catch let error as ChatAttachmentError {
			#expect(error.message == "The pasted image was empty.")
		} catch {}
	}

	@MainActor
	@Test("a pasted screenshot attaches and uploads as an uploaded chip")
	func attachesAndUploads() async throws {
		let uploader = RecordingUploader()
		let model = ChatComposerModel(uploader: uploader, selfActorID: "me")
		let png = screenshotPNG()
		let name = PastedImage.baseName()
		model.attach(name: name, mimeType: "image/jpeg") { try PastedImage.prepare(data: png, name: name) }
		for _ in 0..<200 where model.isUploading { try await Task.sleep(for: .milliseconds(50)) }
		let uploaded = await uploader.uploaded
		#expect(uploaded.count == 1)
		#expect(uploaded.first?.name.hasPrefix("pasted-image-") == true)
		#expect(model.attachments.first?.ref?.fileID == "file-1")
		#expect(model.notice == nil)
	}

	@MainActor
	@Test("a failed paste says why on the chip and in the notice under the bar")
	func failureIsExplained() async throws {
		let model = ChatComposerModel(uploader: RecordingUploader(), selfActorID: "me")
		let name = PastedImage.baseName()
		model.attach(name: name, mimeType: "image/jpeg") { try PastedImage.prepare(data: Data("nope".utf8), name: name) }
		for _ in 0..<200 where model.isUploading { try await Task.sleep(for: .milliseconds(50)) }
		guard case .failed(let reason)? = model.attachments.first?.state else {
			Issue.record("expected the chip to fail")
			return
		}
		#expect(reason.hasPrefix("Couldn't read that image"))
		#expect(model.notice?.contains(reason) == true)
	}
}
