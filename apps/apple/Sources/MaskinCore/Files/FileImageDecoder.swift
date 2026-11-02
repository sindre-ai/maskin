import CoreGraphics
import Foundation
import ImageIO

/// Decodes an image for display without ever inflating it to full size: ImageIO builds a bounded
/// thumbnail straight from the encoded bytes, so a small file declaring a huge canvas can't blow
/// the app's memory budget.
public enum FileImageDecoder {
	public static let maxDisplayPixels = 2048
	/// Above this many source pixels (about 100 MP) the image is refused outright.
	public static let maxSourcePixels = 100_000_000

	public static func thumbnail(
		_ data: Data, maxPixel: Int = maxDisplayPixels, maxSourcePixels: Int = maxSourcePixels
	) -> DecodedImage? {
		let options = [kCGImageSourceShouldCache: false] as CFDictionary
		guard let source = CGImageSourceCreateWithData(data as CFData, options),
			let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
			let width = properties[kCGImagePropertyPixelWidth] as? Int,
			let height = properties[kCGImagePropertyPixelHeight] as? Int,
			width > 0, height > 0, width * height <= maxSourcePixels
		else { return nil }
		let thumbnailOptions =
			[
				kCGImageSourceCreateThumbnailFromImageAlways: true,
				kCGImageSourceCreateThumbnailWithTransform: true,
				kCGImageSourceShouldCacheImmediately: true,
				kCGImageSourceThumbnailMaxPixelSize: maxPixel,
			] as CFDictionary
		return CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions).map(DecodedImage.init)
	}
}

/// A decoded bitmap that can cross actors; the pixels are immutable once created.
public struct DecodedImage: @unchecked Sendable {
	public let cgImage: CGImage
	public init(_ cgImage: CGImage) { self.cgImage = cgImage }
}
