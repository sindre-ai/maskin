import Foundation

/// An agent's own one-tap openers for a new chat with it ("What needs me today?"). Each entry is
/// both the chip's label and the exact text that lands in the message box, so what is printed is
/// what is sent. The web does the same (`packages/shared/src/schemas/starter-prompts.ts`); the
/// reading rules below are a port of its `normalizeStarterPrompts`, so a stale or hand-edited
/// value never becomes an unsendable chip on either client.
public enum StarterPrompts {
	public static let maxCount = 4
	public static let maxLength = 60

	/// The non-empty plain strings, trimmed, de-duplicated (case-insensitively, first spelling
	/// wins) and capped. Anything else is dropped. Lengths are UTF-16 units, like the web's.
	public static func normalize(_ raw: [String]?) -> [String] {
		var seen = Set<String>()
		var prompts: [String] = []
		for entry in raw ?? [] {
			let prompt = entry.trimmingCharacters(in: .whitespacesAndNewlines)
			let key = prompt.lowercased()
			guard !prompt.isEmpty, prompt.utf16.count <= maxLength,
				!prompt.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }),
				!seen.contains(key)
			else { continue }
			seen.insert(key)
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
}
