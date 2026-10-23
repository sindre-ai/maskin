import Foundation

/// How an agent's reply is delivered by voice: in short beats with listening breaks between them,
/// so the person can react instead of being talked at.
public enum LiveCallPace: String, CaseIterable, Sendable, Identifiable {
	/// Breaks between beats and an occasional check-in. The default.
	case relaxed
	/// Shorter breaks, no check-ins.
	case normal
	/// One continuous reading, as before.
	case quick

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .relaxed: "Relaxed"
		case .normal: "Normal"
		case .quick: "Quick"
		}
	}

	/// How long the mic listens between beats.
	public var breakLength: TimeInterval {
		switch self {
		case .relaxed: 1.8
		case .normal: 0.8
		case .quick: 0
		}
	}

	/// The longer break after a check-in question.
	public var checkInBreak: TimeInterval { 3 }
	public var usesCheckIns: Bool { self == .relaxed }
	/// Quick reads the whole reply in one go; the others read it beat by beat.
	public var isPaced: Bool { self != .quick }

	/// `AVSpeechUtterance.rate` (0.5 is the system default): a little slower when relaxed.
	public var speechRate: Float { self == .relaxed ? 0.48 : 0.5 }

	static let key = "live.pace.v1"

	public static func stored(_ defaults: UserDefaults = .standard) -> LiveCallPace {
		defaults.string(forKey: key).flatMap(LiveCallPace.init(rawValue:)) ?? .relaxed
	}

	public func store(_ defaults: UserDefaults = .standard) { defaults.set(rawValue, forKey: Self.key) }
}

public enum SpokenPacing {
	/// One stretch of speech between two listening breaks.
	public struct Beat: Equatable, Sendable {
		public var text: String
		/// The beat closes a paragraph that a blank line follows: a natural place to check in.
		public var endsSection: Bool
		public init(text: String, endsSection: Bool = false) {
			self.text = text
			self.endsSection = endsSection
		}
	}

	public static let maxSentences = 2
	public static let maxWords = 35

	/// Splits speakable text (`SpokenReply.text`) into beats of up to two sentences / about 35 words.
	/// Blocks (separated by a blank line) never share a beat, and consecutive lines of one block
	/// (list items) are read as sentences of it.
	public static func beats(from spoken: String, maxWords: Int = maxWords) -> [Beat] {
		let blocks = spoken.replacingOccurrences(of: "\r\n", with: "\n")
			.components(separatedBy: "\n\n")
			.map { block in
				block.components(separatedBy: "\n")
					.map { $0.trimmingCharacters(in: .whitespaces) }
					.filter { !$0.isEmpty }
					.map(terminated)
					.joined(separator: " ")
			}
			.filter { !$0.isEmpty }
		var beats: [Beat] = []
		for (index, block) in blocks.enumerated() {
			let sections = beats.count
			var current: [String] = []
			var count = 0
			func flush() {
				guard !current.isEmpty else { return }
				beats.append(Beat(text: current.joined(separator: " ")))
				current = []
				count = 0
			}
			for sentence in sentences(in: block) {
				let n = sentence.split(whereSeparator: \.isWhitespace).count
				if !current.isEmpty, current.count >= maxSentences || count + n > maxWords { flush() }
				current.append(sentence)
				count += n
			}
			flush()
			if index < blocks.count - 1, beats.count > sections { beats[beats.count - 1].endsSection = true }
		}
		return beats
	}

	private static func terminated(_ line: String) -> String {
		guard let last = line.last else { return line }
		return ".?!:;…".contains(last) ? line : line + "."
	}

	static func sentences(in text: String) -> [String] {
		var out: [String] = []
		text.enumerateSubstrings(in: text.startIndex..., options: [.bySentences, .substringNotRequired]) {
			_, range, _, _ in
			let sentence = text[range].trimmingCharacters(in: .whitespacesAndNewlines)
			if !sentence.isEmpty { out.append(sentence) }
		}
		return out.isEmpty ? [text] : out
	}

	/// The line spoken (and not posted anywhere) when the reading stops to ask how it is going.
	public static func checkInLine(languageCode: String? = Locale.current.language.languageCode?.identifier) -> String {
		languageCode == "da"
			? "Skal jeg fortsætte, eller vil du grave i noget?"
			: "Want me to keep going, or do you want to dig into something?"
	}
}

/// What a few words said during a break mean for the reading.
public enum SpokenReaction: Equatable, Sendable {
	/// "yes", "ok", "go on", "ja", "fortsæt": carry on.
	case `continue`
	/// "wait", "stop", "hold on", "vent": pause until the person has finished speaking.
	case hold
	/// Anything else is something to say to the agent.
	case turn

	static let continueWords: Set<String> = [
		"yes", "yeah", "yep", "yup", "ok", "okay", "mm", "mmm", "hm", "uh", "huh", "mhm", "mmhm", "mmhmm", "uhhuh", "right",
		"sure", "go", "on", "continue", "next", "fine", "good", "great", "alright", "please", "carry",
		"keep", "going", "and", "then", "ja", "jep", "jo", "fortsæt", "næste", "fint", "godt", "gerne",
		"videre", "selvfølgelig",
	]

	static let holdStarts: Set<String> = ["wait", "stop", "hold", "hang", "pause", "vent", "hov"]

	/// Words that only make up a hold request ("hold on a second", "stop lige").
	static let holdWords: Set<String> = [
		"wait", "stop", "hold", "hang", "on", "a", "second", "minute", "moment", "just", "lige", "vent", "hov",
		"pause", "please", "en", "et", "øjeblik", "sekund", "lidt", "there",
	]

	static func tokens(_ text: String) -> [String] {
		text.lowercased().split(whereSeparator: { $0.isWhitespace || "-,.!?…".contains($0) })
			.map { String($0).trimmingCharacters(in: .punctuationCharacters) }.filter { !$0.isEmpty }
	}

	public static func classify(_ text: String) -> SpokenReaction {
		let words = tokens(text)
		guard let first = words.first else { return .turn }
		if holdStarts.contains(first) { return .hold }
		if words.count <= 4, words.allSatisfy({ continueWords.contains($0) }) { return .continue }
		return .turn
	}

	/// What was said after the hold phrase: "wait what about billing" gives "what about billing".
	public static func afterHold(_ text: String) -> String {
		var words = text.split(whereSeparator: \.isWhitespace).map(String.init)
		while let word = words.first,
			holdWords.contains(word.lowercased().trimmingCharacters(in: .punctuationCharacters))
		{
			words.removeFirst()
		}
		return words.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
	}
}
