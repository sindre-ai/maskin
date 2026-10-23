import Foundation

/// What a live call says aloud for an agent's reply. A long answer full of lists and links is
/// unreadable as speech, so it is cut to its opening sentences and points at the chat for the rest;
/// a short, plain answer is read whole. Everything is stripped of markup either way.
public enum SpokenReply {
	/// Plain answers up to this many words are read in full.
	public static let fullReadWords = 70
	/// A long one is cut to about this many words, at a sentence end.
	public static let summaryWords = 45
	public static let pointer = "The full answer is in the chat."

	public static func text(from markdown: String) -> String {
		let plain = SpeakableText.from(markdown: markdown)
		guard !plain.isEmpty else { return "" }
		let words = plain.split(whereSeparator: \.isWhitespace).count
		if words <= fullReadWords, !isStructured(markdown) { return plain }
		let lead = SpeakableText.from(markdown: leadingProse(of: markdown))
		let summary = firstSentences(of: lead, upTo: summaryWords)
		return summary.isEmpty ? "I've put that in the chat." : "\(summary) \(pointer)"
	}

	/// Lists, tables, headings, code and several links: structure that does not read aloud.
	static func isStructured(_ markdown: String) -> Bool {
		let lines = markdown.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
		let structural = lines.filter { isStructuralLine($0) }.count
		let links = markdown.components(separatedBy: "](").count - 1 + markdown.components(separatedBy: "http").count - 1
		return structural >= 3 || links >= 3
	}

	private static func isStructuralLine(_ line: String) -> Bool {
		line.range(of: #"^([-*+]\s|\d+[.)]\s|#{1,6}\s|\||```|~~~)"#, options: .regularExpression) != nil
	}

	/// The paragraphs before the first list, table, heading or code block.
	static func leadingProse(of markdown: String) -> String {
		var kept: [String] = []
		for raw in markdown.components(separatedBy: "\n") {
			let line = raw.trimmingCharacters(in: .whitespaces)
			if isStructuralLine(line) { break }
			kept.append(line)
		}
		return kept.joined(separator: "\n")
	}

	static func firstSentences(of text: String, upTo limit: Int) -> String {
		let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
		var out: [String] = []
		var count = 0
		var current = ""
		for character in flat {
			current.append(character)
			guard ".?!".contains(character) else { continue }
			let sentence = current.trimmingCharacters(in: .whitespaces)
			current = ""
			let n = sentence.split(whereSeparator: \.isWhitespace).count
			if count > 0, count + n > limit { break }
			out.append(sentence)
			count += n
			if count >= limit { break }
		}
		if out.isEmpty {
			// One long unpunctuated line: cut it at the word limit.
			let words = flat.split(whereSeparator: \.isWhitespace).prefix(limit)
			return words.isEmpty ? "" : words.joined(separator: " ") + "…"
		}
		return out.joined(separator: " ")
	}
}
