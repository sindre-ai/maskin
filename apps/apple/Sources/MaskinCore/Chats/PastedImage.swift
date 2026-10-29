import Foundation

/// An image pasted or dropped into the composer as raw bytes (a screenshot from the keyboard's
/// Paste suggestion, the edit menu or the `+` menu).
public enum PastedImage {
	/// `pasted-image-2026-10-29-18.45.12`, without an extension: the extension follows the bytes.
	public static func baseName(now: Date = Date(), timeZone: TimeZone = .current) -> String {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = timeZone
		formatter.dateFormat = "yyyy-MM-dd-HH.mm.ss"
		return "pasted-image-\(formatter.string(from: now))"
	}

	/// Decodes and downsamples the bytes. The file takes its extension from what the bytes are
	/// (a PNG screenshot stays `.png`), and a failure says which step failed in plain words.
	public static func prepare(data: Data, name: String) throws -> PreparedChatFile {
		guard !data.isEmpty else { throw ChatAttachmentError("The pasted image was empty.") }
		guard let result = ImageDownsampler.prepare(data: data) else {
			throw ChatAttachmentError("Couldn't read that image. It may be in a format Maskin can't open.")
		}
		guard result.data.count <= ChatLimits.maxFileBytes else {
			throw ChatAttachmentError("Over the 10 MB limit.")
		}
		let base = (name as NSString).deletingPathExtension
		return PreparedChatFile(name: "\(base).\(result.fileExtension)", mimeType: result.mimeType, data: result.data)
	}
}
