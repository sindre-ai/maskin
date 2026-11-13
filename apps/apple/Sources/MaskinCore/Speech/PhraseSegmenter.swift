import Foundation

/// Cuts a live recording into phrases at pauses in speech. The speech model behind
/// `POST /api/transcriptions` is one-shot, so "streaming" dictation means closing a phrase as soon
/// as the speaker pauses and transcribing it while they keep talking. The same rules as the web
/// app's `speech-segmenter.ts`, fed level readings (RMS, 0...1) and a clock in milliseconds.
///
/// One difference from the web app: what counts as speech follows the room. The phone's microphone
/// in measurement mode is much quieter than a browser's (no automatic gain), so a fixed level
/// missed whole sessions on an iPad and nothing was ever sent. The level now has to beat a few
/// times the quietest recent reading, capped at `voiceRMS` and never below `minVoiceRMS`.
public struct PhraseSegmenter: Sendable {
	public enum Action: Equatable, Sendable {
		/// The phrase is over; send it.
		case cut
		/// A segment that never held speech ran out; drop it.
		case discard
	}

	public struct Options: Equatable, Sendable {
		/// The most a reading has to reach to count as speech: the level in a noisy room.
		public var voiceRMS: Double = 0.02
		/// The least: in a quiet room a reading still has to reach this to count as speech.
		public var minVoiceRMS: Double = 0.004
		/// How far above the room's own noise a reading has to be to count as speech.
		public var voiceOverFloor: Double = 3
		/// How fast the noise estimate is allowed to rise per reading (it falls at once).
		public var floorRise: Double = 1.002
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
	/// The quietest recent level, which the speech level is measured against. Starts where the
	/// threshold equals `voiceRMS`, so the first readings behave as they always did.
	private var noiseFloor: Double
	/// The level a reading needs to count as speech, as of the last reading.
	public private(set) var threshold: Double
	/// The loudest reading in the current segment, for the log.
	public private(set) var peakRMS = 0.0
	/// Set by the caller while something else (the phone's own recogniser) has heard words in the current
	/// segment. A segment the level never called speech is then sent anyway, not dropped as silence: the
	/// words are there, so a microphone too quiet for the level rule must not lose them.
	public var heardWords = false

	public init(startedAtMs: Double = 0, options: Options = Options()) {
		self.options = options
		segmentStart = startedAtMs
		lastVoiceAt = startedAtMs
		noiseFloor = options.voiceRMS / options.voiceOverFloor
		threshold = options.voiceRMS
	}

	/// Feeds one level reading taken at `nowMs`. A cut or discard ends the segment: call `reset`
	/// before the next reading.
	public mutating func push(rms: Double, atMs nowMs: Double) -> Action? {
		noiseFloor = min(rms, noiseFloor * options.floorRise + 0.00001)
		threshold = max(options.minVoiceRMS, min(options.voiceRMS, noiseFloor * options.voiceOverFloor))
		peakRMS = max(peakRMS, rms)
		if rms >= threshold {
			hasVoice = true
			lastVoiceAt = nowMs
		}
		let needed = nowMs - segmentStart >= options.softCutMs ? options.softSilenceMs : options.silenceMs
		if hasVoice, nowMs - lastVoiceAt >= needed { return .cut }
		if nowMs - segmentStart >= options.maxSegmentMs { return hasVoice || heardWords ? .cut : .discard }
		return nil
	}

	/// Starts a fresh segment at `nowMs`.
	public mutating func reset(atMs nowMs: Double) {
		segmentStart = nowMs
		lastVoiceAt = nowMs
		hasVoice = false
		heardWords = false
		peakRMS = 0
	}
}
