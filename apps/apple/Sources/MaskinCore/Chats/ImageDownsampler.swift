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
		guard let source = CGImageSourceCreateWithURL(url as CFURL, options),
			let type = CGImageSourceGetType(source).flatMap({ UTType($0 as String) })
		else { return nil }
		let props = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any]
		let width = props?[kCGImagePropertyPixelWidth] as? Int ?? 0
		let height = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
		let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
		if max(width, height) <= maxPixelSize, bytes <= passThroughBytes, bytes > 0,
			let data = try? Data(contentsOf: url, options: .mappedIfSafe)
		{
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
		let out = NSMutableData()
		guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)
		else { return nil }
		CGImageDestinationAddImage(dest, thumb, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
		guard CGImageDestinationFinalize(dest) else { return nil }
		return Result(data: out as Data, mimeType: "image/jpeg", fileExtension: "jpg")
	}
}
