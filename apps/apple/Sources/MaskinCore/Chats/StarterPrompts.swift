import Foundation

/// An agent's own one-tap openers for a new chat with it ("What needs me today?"). Each entry is
/// both the chip's label and the exact text that lands in the message box, so what is printed is
/// what is put there. The web does the same (`packages/shared/src/schemas/starter-prompts.ts`).
///
/// The server refuses a bad list on write; this reads a stored one tolerantly. `normalize` is a
/// port of the web's `normalizeStarterPrompts`, held to the same vectors in `StarterPromptsTests`
/// (and `starter-prompts.test.ts` there): change one, change the other. It trims and folds the way
/// JavaScript does, which differs from Foundation's defaults in three places, handled below.
public enum StarterPrompts {
	public static let maxCount = 4
	public static let maxLength = 60

	/// What JavaScript's `String.trim()` removes: the Unicode space separators and tab, plus line
	/// feed, vertical tab, form feed, carriage return, U+FEFF and the line and paragraph
	/// separators. Foundation's `.whitespacesAndNewlines` would also trim U+0085 and would keep
	/// U+FEFF, so it is not used.
	private static let jsWhitespace: CharacterSet = {
		var set = CharacterSet.whitespaces
		set.insert(charactersIn: "\u{0A}\u{0B}\u{0C}\u{0D}\u{FEFF}\u{2028}\u{2029}")
		return set
	}()

	/// A control character: C0 (includes tab and newline), DEL, C1 (includes U+0085, "next line")
	/// and the line and paragraph separators. The same rule as the web's `hasControlCharacter`.
	private static func hasControlCharacter(_ text: String) -> Bool {
		text.unicodeScalars.contains {
			$0.value < 0x20 || ($0.value >= 0x7F && $0.value <= 0x9F) || $0.value == 0x2028 || $0.value == 0x2029
		}
	}

	/// What two prompts are compared by: lower case with the final sigma folded to the ordinary
	/// one. JavaScript's `toLowerCase` picks "ς" at the end of a word and "σ" elsewhere; Swift's
	/// `lowercased()` always picks "σ". Folding makes "ΑΣ" and "ας" one prompt on both clients.
	static func key(_ prompt: String) -> String {
		prompt.lowercased().replacingOccurrences(of: "ς", with: "σ")
	}

	/// The non-empty plain strings, trimmed, de-duplicated (first spelling wins) and capped.
	/// Anything else is dropped. Lengths are UTF-16 units, like the web's.
	public static func normalize(_ raw: [String]?) -> [String] {
		var seen = Set<String>()
		var prompts: [String] = []
		for entry in raw ?? [] {
			let prompt = entry.trimmingCharacters(in: jsWhitespace)
			let folded = key(prompt)
			guard !prompt.isEmpty, prompt.utf16.count <= maxLength, !hasControlCharacter(prompt),
				!seen.contains(folded)
			else { continue }
			seen.insert(folded)
			prompts.append(prompt)
			if prompts.count >= maxCount { break }
		}
		return prompts
	}

	/// The prompts to offer in a chat: those of the one agent in it. `others` is everyone but you.
	/// With no agent, with a person, or with several (a group), nobody's openers fit, so nothing
	/// is offered. An agent that set none offers none; there is no stand-in list.
	public static func forChat(others: [ChatParticipant], actors: [ChatActor]) -> [String] {
		guard others.count == 1, others[0].kind == .agent else { return [] }
		return actors.first { $0.id == others[0].id }?.starterPrompts ?? []
	}

	/// The text of a message box after a starter is tapped: an empty box takes the prompt; a box
	/// with text keeps it and gets the prompt after it, one space between. A tap never erases what
	/// the person typed. The same rule as the web's `withStarterPrompt`.
	public static func inserting(_ prompt: String, into current: String) -> String {
		if current.trimmingCharacters(in: jsWhitespace).isEmpty { return prompt }
		var end = current.endIndex
		while end > current.startIndex {
			let before = current.index(before: end)
			guard current[before].unicodeScalars.allSatisfy({ jsWhitespace.contains($0) }) else { break }
			end = before
		}
		return "\(current[current.startIndex..<end]) \(prompt)"
	}
}
