import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Turns a picked photo into something safe to upload without ever holding the full-resolution
/// bitmap: ImageIO reads straight from the file and decodes a thumbnail at the target size.
public enum ImageDownsampler {
	public static let maxPixelSize = 2048
	/// Anything already smaller than this and within the pixel cap is sent as picked.
	public static let passThroughBytes = 2 * 1024 * 1024

	public struct Result: Sendable {
		public var data: Data
		public var mimeType: String
		public var fileExtension: String
	}

	/// JPEG at `maxPixelSize` on the long edge for big images; the original bytes otherwise. Returns
	/// nil if the file isn't an image ImageIO can read.
	public static func prepare(fileAt url: URL, maxPixelSize: Int = ImageDownsampler.maxPixelSize) -> Result? {
		let options = [kCGImageSourceShouldCache: false] as CFDictionary
		guard let source = CGImageSourceCreateWithURL(url as CFURL, options) else { return nil }
		let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
		return prepare(
			source: source, bytes: bytes, original: { try? Data(contentsOf: url, options: .mappedIfSafe) },
			maxPixelSize: maxPixelSize)
	}

	/// The same for an image already in memory (a pasted screenshot), with no temp file in between.
	public static func prepare(data: Data, maxPixelSize: Int = ImageDownsampler.maxPixelSize) -> Result? {
		let options = [kCGImageSourceShouldCache: false] as CFDictionary
		guard let source = CGImageSourceCreateWithData(data as CFData, options) else { return nil }
		return prepare(source: source, bytes: data.count, original: { data }, maxPixelSize: maxPixelSize)
	}

	private static func prepare(
		source: CGImageSource, bytes: Int, original: () -> Data?, maxPixelSize: Int
	) -> Result? {
		let options = [kCGImageSourceShouldCache: false] as CFDictionary
		guard let type = CGImageSourceGetType(source).flatMap({ UTType($0 as String) }) else { return nil }
		let props = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any]
		let width = props?[kCGImagePropertyPixelWidth] as? Int ?? 0
		let height = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
		if max(width, height) <= maxPixelSize, bytes <= passThroughBytes, bytes > 0, let data = original() {
			return Result(
				data: data, mimeType: type.preferredMIMEType ?? "image/jpeg",
				fileExtension: type.preferredFilenameExtension ?? "jpg")
		}
		let thumbOptions =
			[
				kCGImageSourceCreateThumbnailFromImageAlways: true,
				kCGImageSourceCreateThumbnailWithTransform: true,
				kCGImageSourceShouldCacheImmediately: true,
				kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
			] as CFDictionary
		guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions) else { return nil }
		// A screenshot carries an alpha channel and wide colour, which JPEG can refuse: fall back to PNG.
		if let jpeg = encode(thumb, as: .jpeg, quality: 0.8) {
			return Result(data: jpeg, mimeType: "image/jpeg", fileExtension: "jpg")
		}
		if let png = encode(thumb, as: .png, quality: nil) {
			return Result(data: png, mimeType: "image/png", fileExtension: "png")
		}
		return nil
	}

	private static func encode(_ image: CGImage, as type: UTType, quality: Double?) -> Data? {
		let out = NSMutableData()
		guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
		let properties = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
		CGImageDestinationAddImage(dest, image, properties)
		return CGImageDestinationFinalize(dest) ? out as Data : nil
	}
}
