import Foundation

/// The formatting row above the message box: which formats it offers, in the web's order, and
/// whether this person has it open. Hidden until they choose "Show formatting" in the `+` menu,
/// then remembered for that person on this device, as on the web.
public enum ComposerFormatting {
	/// Bold, italic, strikethrough, link, bulleted list, numbered list, quote, inline code, code
	/// block. No headings, tables or colours.
	public static let formats: [MarkdownFormat] = [
		.bold, .italic, .strikethrough, .link, .bullet, .numbered, .quote, .code, .codeBlock,
	]

	static func key(actorID: String) -> String { "chat.composer.showFormatting.\(actorID)" }

	public static func isShown(actorID: String, defaults: UserDefaults = .standard) -> Bool {
		defaults.bool(forKey: key(actorID: actorID))
	}

	public static func setShown(_ shown: Bool, actorID: String, defaults: UserDefaults = .standard) {
		defaults.set(shown, forKey: key(actorID: actorID))
	}
}
