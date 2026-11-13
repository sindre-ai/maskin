import Foundation

/// Pure helpers for playing a video file, kept here so they test without a player.
public enum FileVideo {
	/// The extension the player needs to recognise the container: the file's own when it has one,
	/// otherwise taken from the MIME type. Falls back to "mp4".
	public static func fileExtension(mimeType: String, name: String) -> String {
		let own = (name as NSString).pathExtension.lowercased()
		if !own.isEmpty, own.allSatisfy({ $0.isLetter || $0.isNumber }) { return own }
		let mime = mimeType.lowercased().split(separator: ";").first.map(String.init) ?? ""
		switch mime {
		case "video/quicktime": return "mov"
		case "video/x-m4v": return "m4v"
		default: return "mp4"
		}
	}

	/// Width over height for the player frame, so a portrait video (540x960) gets a tall frame and
	/// is not cropped or letterboxed. Anything unreadable reads as 16:9.
	public static func aspectRatio(width: Double, height: Double) -> Double {
		let w = abs(width), h = abs(height)
		guard w.isFinite, h.isFinite, w > 0, h > 0 else { return 16.0 / 9.0 }
		return w / h
	}
}
