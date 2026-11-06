import Foundation

/// Pure helpers for playing an audio file, kept here so they test without a player.
public enum FileAudio {
	/// "1:05", "12:34", "1:02:03". Negative, NaN and infinite values read as "0:00".
	public static func timeText(_ seconds: Double) -> String {
		guard seconds.isFinite, seconds > 0 else { return "0:00" }
		let total = Int(seconds)
		let hours = total / 3600
		let minutes = (total % 3600) / 60
		let secs = total % 60
		let tail = String(format: "%02d", secs)
		return hours > 0 ? "\(hours):\(String(format: "%02d", minutes)):\(tail)" : "\(minutes):\(tail)"
	}

	/// The extension the player needs to recognise the container: the file's own when it has one,
	/// otherwise taken from the MIME type. Falls back to "m4a", which AVFoundation sniffs by content.
	public static func fileExtension(mimeType: String, name: String) -> String {
		let own = (name as NSString).pathExtension.lowercased()
		if !own.isEmpty, own.allSatisfy({ $0.isLetter || $0.isNumber }) { return own }
		let mime = mimeType.lowercased().split(separator: ";").first.map(String.init) ?? ""
		switch mime {
		case "audio/mpeg", "audio/mp3": return "mp3"
		case "audio/wav", "audio/x-wav", "audio/wave": return "wav"
		case "audio/aac": return "aac"
		case "audio/flac", "audio/x-flac": return "flac"
		default: return "m4a"
		}
	}
}
