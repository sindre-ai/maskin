import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Prepares a shared image for upload without ever decoding it at full size: ImageIO reads the
/// file and produces a thumbnail at the target size. The share extension has roughly 120 MB, and
/// a 48 MP photo decoded in full is ~190 MB.
enum ShareImageEncoder {
	struct Output {
		var mimeType: String
		var fileExtension: String
	}

	/// Writes the prepared image to `destination` (extension added by the caller from `Output`).
	/// - JPEG/PNG/GIF within the size caps are copied as they are.
	/// - Everything else (HEIC, TIFF, RAW, oversized) becomes a JPEG at `maxPixels` on the long
	///   edge, because the web app can't show HEIC. A large PNG stays a PNG so transparency survives.
	static func write(
		from source: URL, to destination: (String) -> URL, maxPixels: Int = ShareLimits.maxImagePixels,
		maxBytes: Int = ShareLimits.maxFileBytes, passThroughBytes: Int = 2 * 1024 * 1024
	) throws -> (url: URL, output: Output, bytes: Int) {
		let options = [kCGImageSourceShouldCache: false] as CFDictionary
		guard let image = CGImageSourceCreateWithURL(source as CFURL, options),
			let typeIdentifier = CGImageSourceGetType(image) as String?, let type = UTType(typeIdentifier)
		else { throw ShareItemUnreadable() }
		let props = CGImageSourceCopyPropertiesAtIndex(image, 0, options) as? [CFString: Any]
		let width = props?[kCGImagePropertyPixelWidth] as? Int ?? 0
		let height = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
		let bytes = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
		let passThrough: [UTType: String] = [.jpeg: "jpg", .png: "png", .gif: "gif"]

		if let ext = passThrough[type], max(width, height) <= maxPixels, bytes > 0, bytes <= passThroughBytes {
			let target = destination(ext)
			try FileManager.default.copyItem(at: source, to: target)
			return (target, Output(mimeType: type.preferredMIMEType ?? "image/jpeg", fileExtension: ext), bytes)
		}

		let thumbOptions =
			[
				kCGImageSourceCreateThumbnailFromImageAlways: true,
				kCGImageSourceCreateThumbnailWithTransform: true,
				kCGImageSourceShouldCacheImmediately: true,
				kCGImageSourceThumbnailMaxPixelSize: maxPixels,
			] as CFDictionary
		guard let thumb = CGImageSourceCreateThumbnailAtIndex(image, 0, thumbOptions) else {
			throw ShareItemUnreadable()
		}
		for (format, ext, quality) in encodings(for: type) {
			let target = destination(ext)
			guard let sink = CGImageDestinationCreateWithURL(target as CFURL, format.identifier as CFString, 1, nil)
			else { throw ShareItemUnreadable() }
			var properties: [CFString: Any] = [:]
			if format == .jpeg { properties[kCGImageDestinationLossyCompressionQuality] = quality }
			CGImageDestinationAddImage(sink, thumb, properties as CFDictionary)
			guard CGImageDestinationFinalize(sink) else { throw ShareItemUnreadable() }
			let written = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
			if written > 0, written <= maxBytes {
				return (target, Output(mimeType: format.preferredMIMEType ?? "image/jpeg", fileExtension: ext), written)
			}
			try? FileManager.default.removeItem(at: target)
		}
		throw ShareItemUnreadable()
	}

	/// PNG sources try PNG first (keeps transparency), then JPEG if that is over the cap.
	private static func encodings(for type: UTType) -> [(UTType, String, Double)] {
		let jpeg: (UTType, String, Double) = (.jpeg, "jpg", 0.8)
		return type.conforms(to: .png) ? [(.png, "png", 1), jpeg] : [jpeg]
	}
}
