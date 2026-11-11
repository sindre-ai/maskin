import Foundation

/// A message over the chat cap, turned into a short readable body plus the full text as a .txt
/// attachment. The same split and wording as the web composer (`apps/web/src/lib/long-message.ts`),
/// so both clients read alike.
public struct LongMessageSplit: Equatable, Sendable {
	/// Short body that fits the cap and points at the attachment.
	public var body: String
	public var fileName: String
	public var fileText: String

	/// How much of the typed text stays in the body, so the chat shows what the message was about.
	static let previewCharacters = 500

	/// Nil when the text already fits.
	public static func make(_ text: String, now: Date = Date()) -> LongMessageSplit? {
		guard text.count > ChatLimits.maxMessageLength else { return nil }
		let cut = String(text.prefix(previewCharacters))
		// Break on a space when there is one near the end, so a word is not cut in half.
		var preview = cut
		if let space = cut.lastIndex(of: " "),
			cut.distance(from: cut.startIndex, to: space) > Int(Double(previewCharacters) * 0.6)
		{
			preview = String(cut[..<space])
		}
		preview = preview.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
		let name = "message-\(stamp(now)).txt"
		let count = text.count.formatted(.number.locale(Locale(identifier: "en_US")))
		return LongMessageSplit(
			body: "\(preview)…\n\nThe full message (\(count) characters) is attached as \(name).",
			fileName: name, fileText: text)
	}

	/// `2026-11-11-09-30-00` in UTC, like the web's ISO timestamp with `:` and `T` as dashes.
	private static func stamp(_ date: Date) -> String {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
		let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
		return String(
			format: "%04d-%02d-%02d-%02d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0,
			c.minute ?? 0, c.second ?? 0)
	}
}
