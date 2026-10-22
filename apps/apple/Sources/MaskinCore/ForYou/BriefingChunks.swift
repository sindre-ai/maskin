import Foundation

/// Splits a spoken briefing into screen-sized pieces for the TV player: one piece per slide, each
/// read aloud as it is shown. Breaks fall between paragraphs first, then between sentences, never
/// inside one, so the narration and the words on screen stay together.
public enum BriefingChunks {
	public static let defaultMaxCharacters = 220

	public static func split(script: String, maxCharacters: Int = defaultMaxCharacters) -> [String] {
		let limit = max(40, maxCharacters)
		var chunks: [String] = []
		for paragraph in script.components(separatedBy: "\n") {
			let text = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
			if text.isEmpty { continue }
			var current = ""
			for sentence in sentences(of: text) {
				if current.isEmpty {
					current = sentence
				} else if current.count + 1 + sentence.count <= limit {
					current += " " + sentence
				} else {
					chunks.append(current)
					current = sentence
				}
			}
			if !current.isEmpty { chunks.append(current) }
		}
		return chunks
	}

	private static func sentences(of text: String) -> [String] {
		var result: [String] = []
		text.enumerateSubstrings(in: text.startIndex..., options: [.bySentences, .substringNotRequired]) {
			_, range, _, _ in
			let s = text[range].trimmingCharacters(in: .whitespacesAndNewlines)
			if !s.isEmpty { result.append(s) }
		}
		return result.isEmpty ? [text] : result
	}
}
