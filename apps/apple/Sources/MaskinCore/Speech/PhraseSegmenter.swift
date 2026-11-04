import Foundation

/// Cuts a live recording into phrases at pauses in speech. The speech model behind
/// `POST /api/transcriptions` is one-shot, so "streaming" dictation means closing a phrase as soon
/// as the speaker pauses and transcribing it while they keep talking. The same rules as the web
/// app's `speech-segmenter.ts`, fed level readings (RMS, 0...1) and a clock in milliseconds.
public struct PhraseSegmenter: Sendable {
	public enum Action: Equatable, Sendable {
		/// The phrase is over; send it.
		case cut
		/// A segment that never held speech ran out; drop it.
		case discard
	}

	public struct Options: Equatable, Sendable {
		/// RMS level at or above which a reading counts as speech.
		public var voiceRMS: Double = 0.02
		/// Silence after speech that closes a phrase.
		public var silenceMs: Double = 400
		/// Once a phrase is this long, even a short breath between words closes it.
		public var softCutMs: Double = 2_000
		/// The shorter silence that closes a phrase past `softCutMs`.
		public var softSilenceMs: Double = 150
		/// Hard cap on one phrase, so a speaker who never pauses still streams.
		public var maxSegmentMs: Double = 6_000

		public init() {}
	}

	private let options: Options
	private var segmentStart: Double
	private var lastVoiceAt: Double
	public private(set) var hasVoice = false

	public init(startedAtMs: Double = 0, options: Options = Options()) {
		self.options = options
		segmentStart = startedAtMs
		lastVoiceAt = startedAtMs
	}

	/// Feeds one level reading taken at `nowMs`. A cut or discard ends the segment: call `reset`
	/// before the next reading.
	public mutating func push(rms: Double, atMs nowMs: Double) -> Action? {
		if rms >= options.voiceRMS {
			hasVoice = true
			lastVoiceAt = nowMs
		}
		let needed = nowMs - segmentStart >= options.softCutMs ? options.softSilenceMs : options.silenceMs
		if hasVoice, nowMs - lastVoiceAt >= needed { return .cut }
		if nowMs - segmentStart >= options.maxSegmentMs { return hasVoice ? .cut : .discard }
		return nil
	}

	/// Starts a fresh segment at `nowMs`.
	public mutating func reset(atMs nowMs: Double) {
		segmentStart = nowMs
		lastVoiceAt = nowMs
		hasVoice = false
	}
}
