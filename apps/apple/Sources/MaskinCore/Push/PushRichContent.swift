import Foundation

// STANDALONE: Foundation only. Compiled directly into the notification service extension
// (project.yml), like `PushDecision.swift`.
//
// The server contract (apps/dev/src/services/apns.ts, `buildApnsPayload`): an optional root key
//
//     "image_url": "https://…"        https only, at most 500 characters
//
// names an image the extension downloads and attaches to the banner. Everything else a rich push
// needs (`thread-id`, `interruption-level`, `badge`) is read by iOS itself from `aps`.

/// Rules for the image a push may attach. Pure, so what the extension accepts is tested.
public enum PushImage {
	public static let maxURLLength = 500
	/// Beyond this the download is dropped: an extension has ~24 MB and 30 s to live in.
	public static let maxBytes = 5 * 1024 * 1024
	public static let timeout: TimeInterval = 12

	/// The attachment URL from a push, or `nil` when absent, malformed or not https.
	public static func url(from userInfo: [AnyHashable: Any]) -> URL? {
		guard let raw = userInfo["image_url"] as? String, raw.count <= maxURLLength,
			let url = URL(string: raw), url.scheme?.lowercased() == "https",
			let host = url.host, !host.isEmpty
		else { return nil }
		return url
	}

	/// The file extension `UNNotificationAttachment` needs to recognise the type, from the
	/// response's Content-Type. `nil` for anything that is not an image iOS can show.
	public static func fileExtension(forMIMEType mime: String?) -> String? {
		let type = mime?.split(separator: ";").first?
			.trimmingCharacters(in: .whitespaces).lowercased()
		switch type {
		case "image/jpeg", "image/jpg": return "jpg"
		case "image/png": return "png"
		case "image/gif": return "gif"
		case "image/heic": return "heic"
		case "image/webp": return "webp"
		default: return nil
		}
	}

	/// Whether the bytes delivered are within budget.
	public static func isWithinBudget(_ byteCount: Int64) -> Bool {
		byteCount > 0 && byteCount <= Int64(maxBytes)
	}
}
