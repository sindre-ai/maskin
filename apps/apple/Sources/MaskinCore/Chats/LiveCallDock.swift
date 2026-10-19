import Foundation

/// What the call card in the thread remembers about how you left it: open or folded to a bar, with
/// captions and the loudspeaker on or off. Kept by the shell's call so it survives leaving the thread.
public struct LiveCallDockState: Equatable, Sendable {
	/// Folded to the compact bar.
	public var isCollapsed = false
	public var captionsOn = false
	/// The loudspeaker (true) or the earpiece (false).
	public var speakerOn = true

	public init() {}

	public mutating func toggleCollapsed() { isCollapsed.toggle() }
	public mutating func toggleCaptions() { captionsOn.toggle() }
	public mutating func toggleSpeaker() { speakerOn.toggle() }

	/// "Speaker" / "Earpiece": the name under the speaker control.
	public var speakerLabel: String { speakerOn ? "Speaker" : "Earpiece" }
	/// "Mic" / "Muted": the name under the microphone control.
	public static func micLabel(isMuted: Bool) -> String { isMuted ? "Muted" : "Mic" }
}

/// The words in the captions panel: what the agent is saying while it speaks, what you are saying
/// while it is your turn, otherwise the last thing the agent said.
public enum LiveCallCaption {
	public static func text(
		phase: LiveVoicePhase, agentSpeaking: String?, yourWords: String, lastAgentLine: String?,
		leadName: String
	) -> String {
		let speaking = agentSpeaking?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let mine = yourWords.trimmingCharacters(in: .whitespacesAndNewlines)
		let last = lastAgentLine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		if phase == .speaking, !speaking.isEmpty { return speaking }
		if !mine.isEmpty { return mine }
		if !last.isEmpty { return last }
		return "Captions appear here when \(leadName) speaks."
	}
}

/// The open decision a briefing call is on: its question and the answers as buttons. Answering
/// goes through the same path as the For you card, so the feed and the call agree.
public struct LiveCallDecision: Equatable, Sendable {
	public var card: ForYouCard
	public var ask: String
	/// The recommended answer (else the first), drawn as the dark button.
	public var main: DecisionOption
	/// Up to two other answers.
	public var alternatives: [DecisionOption]
	/// How many decisions are open, including this one.
	public var openCount: Int

	/// The first open decision in the feed. Answers that cannot be undone or reach real people
	/// (`destructive`) are left off: the card asks for a confirmation on For you, and a tap during
	/// a call is too easy to make by accident. A decision with no other answer is skipped.
	public static func current(in entries: [FeedEntry]) -> LiveCallDecision? {
		let open = entries.filter { $0.bucket == .needs && $0.card.kind == .decision }
		for entry in open {
			guard let prompt = entry.card.decision else { continue }
			let safe = prompt.options.filter { !$0.destructive }
			guard let main = safe.first(where: \.recommended) ?? safe.first else { continue }
			let rest = safe.filter { $0.id != main.id }
			let ask = prompt.ask.trimmingCharacters(in: .whitespacesAndNewlines)
			return LiveCallDecision(
				card: entry.card, ask: ask.isEmpty ? prompt.title : ask, main: main,
				alternatives: Array(rest.prefix(2)), openCount: open.count)
		}
		return nil
	}

	/// "DECIDING NOW · 3 OPEN".
	public var label: String { "DECIDING NOW · \(openCount) OPEN" }
}

/// The two letters in an avatar that has no picture: first letters of the first two words.
public enum LiveCallInitials {
	public static func text(_ name: String) -> String {
		let words = name.split(whereSeparator: \.isWhitespace)
		if words.count > 1, let a = words[0].first, let b = words[1].first { return "\(a)\(b)".uppercased() }
		return String(name.trimmingCharacters(in: .whitespaces).prefix(2)).uppercased()
	}
}
