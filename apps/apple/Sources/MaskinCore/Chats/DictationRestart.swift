import Foundation

/// Keeps what was recognised across recogniser restarts. Each recognition task reports only its own
/// utterance, so when one ends on a pause and a new one begins, the finished text is committed and
/// the new transcript is appended to it. Pure strings only: no indices to go stale.
public struct DictationAccumulator: Equatable, Sendable {
	public private(set) var committed = ""
	public private(set) var current = ""
	/// The last transcript the recogniser reported, to notice it starting over.
	private var last = ""

	public init() {}

	/// The running transcript of the task that is listening now. It normally replaces the previous
	/// partial (the recogniser revises its own words). When it instead starts over, with a shorter
	/// text that shares nothing with the old one, the recogniser has dropped what it heard so far
	/// without ever calling it final (it does this after a long pause); the old text is kept.
	public mutating func update(_ transcript: String) {
		if Self.startedOver(from: last, to: transcript) {
			committed = DictationText.merge(base: committed, transcript: current)
		}
		last = transcript
		current = transcript
	}

	/// The task ended: keep what it heard and start the next one from empty.
	public mutating func roll() {
		committed = DictationText.merge(base: committed, transcript: current)
		current = ""
		last = ""
	}

	/// Everything recognised so far, across restarts.
	public var text: String { DictationText.merge(base: committed, transcript: current) }

	private static func words(_ text: String) -> [String] {
		text.split(whereSeparator: \.isWhitespace).map {
			$0.lowercased().trimmingCharacters(in: .punctuationCharacters)
		}
	}

	static func startedOver(from old: String, to new: String) -> Bool {
		let before = words(old)
		let after = words(new)
		guard before.count >= 3, !after.isEmpty, after.count < before.count else { return false }
		return before.first != after.first
	}
}

/// Merges dictation into a field the person can also type in. The first words of the transcript go
/// after what was in the field when the mic opened; if the field is edited meanwhile, the edit is
/// kept as the new base and only words spoken after it are appended.
public struct DictationDraft: Equatable, Sendable {
	private var base: String
	/// The part of the transcript already folded into `base` by an edit.
	private var skip = ""
	private var lastTranscript = ""
	private var lastApplied: String

	public init(base: String) {
		self.base = base
		lastApplied = base
	}

	/// The field's new text for the recogniser's running `transcript`. `field` is what the field
	/// holds now; if that is not what this draft last wrote, the person typed.
	public mutating func apply(transcript: String, field: String) -> String {
		if field != lastApplied {
			base = field
			skip = lastTranscript
		}
		lastTranscript = transcript
		let spoken = Self.remainder(of: transcript, after: skip)
		lastApplied = DictationText.merge(base: base, transcript: spoken)
		return lastApplied
	}

	private static func remainder(of transcript: String, after skip: String) -> String {
		guard !skip.isEmpty else { return transcript }
		if transcript.hasPrefix(skip) { return String(transcript.dropFirst(skip.count)) }
		// Revised inside the part already kept: drop only what still matches.
		var shared = 0
		for (a, b) in zip(transcript, skip) {
			guard a == b else { break }
			shared += 1
		}
		return String(transcript.dropFirst(shared))
	}
}

/// Decides whether a recogniser task that ended should be replaced by a new one, so recording
/// continues until the person taps Done or Discard. It refuses to loop on a recogniser that keeps
/// failing at once (no speech engine, no input, a revoked permission).
public struct DictationRestartPolicy: Equatable, Sendable {
	public enum Decision: Equatable, Sendable { case restart, stop }

	/// A task that ends sooner than this without hearing anything counts as a quick failure.
	public static let usefulRun: TimeInterval = 1.0
	/// Consecutive quick failures tolerated before giving up.
	public static let maxQuickFailures = 3

	public private(set) var quickFailures = 0

	public init() {}

	public mutating func taskEnded(ranFor: TimeInterval, heardText: Bool, fatal: Bool) -> Decision {
		if fatal { return .stop }
		if heardText || ranFor >= Self.usefulRun {
			quickFailures = 0
			return .restart
		}
		quickFailures += 1
		return quickFailures >= Self.maxQuickFailures ? .stop : .restart
	}
}
