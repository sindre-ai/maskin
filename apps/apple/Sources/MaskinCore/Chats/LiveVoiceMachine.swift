import Foundation

/// The turn-taking of a live voice conversation with an agent, with no audio in it: it is told what
/// was heard, what time it is, when a reply arrives and when speech ends, and answers with what to do.
///
///     listening ──(you pause)──▶ thinking ──(reply arrives)──▶ speaking ──(speech ends)──▶ listening
///                                                                  │
///                                          (you talk over it) ─────┘──▶ listening
///
/// The microphone stays open for the whole call (unless muted): you can add to what you said while
/// the agent is still working, and talking over the agent cuts it off. What you say is committed as
/// soon as it is final (a short silence, or the recogniser calling it final) and each committed
/// line is a command to send, so the thread has the call as it happens.
public struct LiveVoiceMachine: Sendable, Equatable {
	public enum Command: Equatable, Sendable {
		case startListening
		case stopListening
		/// Start the recogniser's transcript over (what it holds was sent, dropped or is echo).
		case resetTranscript
		/// Send what was said as a message.
		case send(String)
		/// Read this message aloud (queued after any already being read).
		case speak(messageID: String)
		case stopSpeaking
	}

	public private(set) var phase: LiveVoicePhase = .listening
	/// What has been heard since the last message was sent.
	public private(set) var transcript = ""
	public private(set) var isMuted = false

	/// How long you must stop talking before what you said is sent. People pause to think mid
	/// sentence, so this is generous; the shorter and longer windows below adapt it to what was said.
	public var silenceWindow: TimeInterval = 2.4
	/// The words end like a finished sentence ("…at the moment?"): a shorter pause will do.
	public var sentenceEndWindow: TimeInterval = 1.3
	/// The words trail off like a half-said thought ("tell me what", "and", a comma): wait longer.
	public var unfinishedWindow: TimeInterval = 4.5
	/// The words end on a preposition ("working on"): could be done, could be mid-thought.
	public var prepositionWindow: TimeInterval = 3.2
	/// A lone "yes" / "no" is an answer on its own.
	public var singleWordWindow: TimeInterval = 1.6
	/// The recogniser calling the utterance final shortens the wait, but never for an unfinished one.
	public var finalWindow: TimeInterval = 1.0
	/// How many words not coming from the agent's own voice it takes to cut the agent off.
	public var bargeInWords = 2
	/// How long to wait for a reply before listening again.
	public var replyTimeout: TimeInterval = 90
	/// How long a filler ("um", a cough) is kept before it is forgotten.
	public var fragmentLifetime: TimeInterval = 4

	private var lastHeardAt: Date?
	private var transcriptIsFinal = false
	private var thinkingSince: Date?
	/// Words of the replies being read, so the agent's own voice picked up by the microphone is not
	/// taken for you talking over it.
	private var spokenWords: Set<String> = []

	public init() {}

	/// Start (or restart) the conversation, listening.
	public mutating func begin() -> [Command] { resumeListening() }

	/// The recogniser's running transcript. Only a change counts as speech: the pause is measured
	/// from the last time the words changed. `isFinal` is the recogniser saying the utterance is over.
	public mutating func heard(_ text: String, at now: Date, isFinal: Bool = false) -> [Command] {
		guard !isMuted else { return [] }
		switch phase {
		case .listening, .thinking:
			if text != transcript {
				transcript = text
				lastHeardAt = now
				transcriptIsFinal = false
			}
			if isFinal, !transcript.isEmpty { transcriptIsFinal = true }
			return []
		case .speaking:
			let yours = Self.words(text).filter { !spokenWords.contains($0) }
			// Echo of the agent's own voice (or a cough) is not you. Real words are.
			guard yours.count >= bargeInWords else { return [] }
			let stop = interrupt()
			transcript = text
			lastHeardAt = now
			// Keep the recogniser's transcript: its words so far are the start of your turn.
			return stop.filter { $0 != .startListening && $0 != .resetTranscript }
		}
	}

	public mutating func tick(at now: Date) -> [Command] {
		switch phase {
		case .listening, .thinking:
			var out: [Command] = []
			if phase == .thinking, let since = thinkingSince, now.timeIntervalSince(since) >= replyTimeout {
				out += resumeListening()
			}
			guard !isMuted, let heardAt = lastHeardAt else { return out }
			let quiet = now.timeIntervalSince(heardAt)
			let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
			let words = Self.words(text)
			guard words.contains(where: { !Self.fillers.contains($0) }) else {
				if quiet >= fragmentLifetime {
					transcript = ""
					lastHeardAt = nil
					transcriptIsFinal = false
					out.append(.resetTranscript)
				}
				return out
			}
			guard quiet >= window(for: text, words: words) else { return out }
			transcript = ""
			lastHeardAt = nil
			transcriptIsFinal = false
			phase = .thinking
			thinkingSince = now
			return out + [.resetTranscript, .send(text)]
		case .speaking:
			return []
		}
	}

	/// Whether `text` is only words the agent is saying itself (its voice back through the microphone).
	public func isEcho(_ text: String) -> Bool {
		let words = Self.words(text)
		return !words.isEmpty && words.allSatisfy { spokenWords.contains($0) }
	}

	/// Whether `text` is only fillers or a cough.
	public func isFiller(_ text: String) -> Bool {
		!Self.words(text).contains { !Self.fillers.contains($0) }
	}

	/// "Go on" after the agent was cut off: back to speaking the rest of what it was saying.
	public mutating func resumeSpeaking(text: String) -> [Command] {
		guard phase == .listening, !isMuted else { return [] }
		phase = .speaking
		transcript = ""
		lastHeardAt = nil
		transcriptIsFinal = false
		spokenWords = Set(Self.words(text))
		return [.resetTranscript]
	}

	/// Send what has been heard now, without waiting out the pause ("Send now").
	public mutating func commitNow(at now: Date) -> [Command] {
		guard !isMuted, phase == .listening || phase == .thinking, let text = pendingText else { return [] }
		transcript = ""
		lastHeardAt = nil
		transcriptIsFinal = false
		phase = .thinking
		thinkingSince = now
		return [.resetTranscript, .send(text)]
	}

	/// How long to be quiet before `text` counts as finished.
	func window(for text: String, words: [String]) -> TimeInterval {
		let last = words.last ?? ""
		let trailsOff =
			text.hasSuffix(",") || text.hasSuffix(":") || text.hasSuffix(";") || text.hasSuffix("-")
			|| text.hasSuffix("…") || Self.unfinishedEndings.contains(last)
		if trailsOff { return unfinishedWindow }
		if Self.prepositions.contains(last), !text.hasSuffix("?") { return prepositionWindow }
		if transcriptIsFinal { return finalWindow }
		let ended = text.hasSuffix(".") || text.hasSuffix("?") || text.hasSuffix("!")
		if words.count == 1 { return Self.shortAnswers.contains(last) || ended ? singleWordWindow : silenceWindow }
		return ended ? sentenceEndWindow : silenceWindow
	}

	/// An agent message arrived. While waiting for one it starts being read; while one is being read
	/// it joins the queue; at any other time (a reply to something typed) it is left alone.
	public mutating func replyArrived(messageID: String, text: String = "") -> [Command] {
		switch phase {
		case .thinking:
			phase = .speaking
			spokenWords = Set(Self.words(text))
			return [.resetTranscript, .speak(messageID: messageID)]
		case .speaking:
			spokenWords.formUnion(Self.words(text))
			return [.speak(messageID: messageID)]
		case .listening:
			return []
		}
	}

	/// The call opens with the agent saying `text` (a fixed line, never sent to the chat). It is treated like a
	/// reply being read, so the agent's own voice through the microphone is not taken for you, and talking
	/// over it cuts it off as usual. Still speaks when muted.
	public mutating func greet(messageID: String, text: String) -> [Command] {
		guard phase == .listening else { return [] }
		phase = .speaking
		transcript = ""
		lastHeardAt = nil
		transcriptIsFinal = false
		spokenWords = Set(Self.words(text))
		return [.resetTranscript, .speak(messageID: messageID)]
	}

	/// The agent's turn ended in an error: nothing to read, so listen again.
	public mutating func replyFailed() -> [Command] {
		guard phase == .thinking else { return [] }
		return resumeListening()
	}

	/// The reader finished everything queued.
	public mutating func speechFinished() -> [Command] {
		guard phase == .speaking else { return [] }
		return resumeListening()
	}

	/// You started talking over the agent, or tapped to stop it.
	public mutating func interrupt() -> [Command] {
		guard phase == .speaking || phase == .thinking else { return [] }
		return [.stopSpeaking] + resumeListening()
	}

	public mutating func setMuted(_ muted: Bool) -> [Command] {
		guard muted != isMuted else { return [] }
		isMuted = muted
		if muted {
			transcript = ""
			lastHeardAt = nil
			transcriptIsFinal = false
			return [.stopListening]
		}
		return [.startListening]
	}

	/// What was heard but not yet sent, for saving when the call ends or is cut off.
	public var pendingText: String? {
		let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
		return Self.words(text).contains(where: { !Self.fillers.contains($0) }) ? text : nil
	}

	public mutating func end() -> [Command] { [.stopListening, .stopSpeaking] }

	private mutating func resumeListening() -> [Command] {
		phase = .listening
		transcript = ""
		lastHeardAt = nil
		transcriptIsFinal = false
		thinkingSince = nil
		spokenWords = []
		return isMuted ? [.resetTranscript] : [.resetTranscript, .startListening]
	}

	// MARK: Words

	static let shortAnswers: Set<String> = [
		"yes", "no", "yeah", "yep", "nope", "okay", "ok", "sure", "stop", "thanks", "continue", "next",
	]

	/// Words a finished thought does not end on.
	static let unfinishedEndings: Set<String> = [
		"and", "but", "so", "or", "because", "if", "when", "while", "that", "which", "who", "whom", "whose",
		"the", "a", "an", "to", "of", "than",
		"what", "how", "why", "where", "whether", "some", "any", "are", "is", "was", "were", "be", "can",
		"could", "would", "should", "will", "do", "does", "did", "have", "has", "my", "your", "our", "their",
		"its", "i", "i'm", "i'd", "i'll", "we", "you", "they", "then", "also", "like", "um", "uh", "umm", "uhh",
		"as", "not", "just", "tell", "show", "give", "send", "list",
	]

	static let prepositions: Set<String> = [
		"in", "on", "at", "for", "with", "about", "from", "by", "into", "onto", "over", "under", "between",
	]

	static let fillers: Set<String> = ["um", "uh", "umm", "uhh", "hmm", "hm", "mm", "mmm", "er", "ah", "eh"]

	static func words(_ text: String) -> [String] {
		text.split(whereSeparator: \.isWhitespace)
			.map { $0.lowercased().trimmingCharacters(in: .punctuationCharacters) }
			.filter { !$0.isEmpty }
	}
}
