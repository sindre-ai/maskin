// Phrase segmentation for streaming dictation. The speech model behind
// `POST /transcriptions` is one-shot, so "streaming" means cutting the live
// recording at pauses and transcribing each phrase as soon as it is closed.

export interface SegmenterOptions {
	/** RMS level (0..1) at or above which a reading counts as speech. */
	voiceRms?: number
	/** Silence after speech that closes a phrase. */
	silenceMs?: number
	/** Once a phrase is this long, even a short breath between words closes it. */
	softCutMs?: number
	/** The shorter silence that closes a phrase past `softCutMs`. */
	softSilenceMs?: number
	/** Hard cap on one phrase, so a speaker who never pauses still streams. */
	maxSegmentMs?: number
}

export type SegmenterAction = 'cut' | 'discard' | null

export interface Segmenter {
	/** Feed one level reading. `cut` closes the phrase; `discard` closes a segment that never held speech. */
	push: (rms: number, now: number) => SegmenterAction
	/** Whether speech was heard since the last reset. */
	hasVoice: () => boolean
	/** Start a fresh segment. */
	reset: (now: number) => void
}

export function createSegmenter(startedAt: number, options: SegmenterOptions = {}): Segmenter {
	const voiceRms = options.voiceRms ?? 0.02
	const silenceMs = options.silenceMs ?? 400
	const softCutMs = options.softCutMs ?? 2_000
	const softSilenceMs = options.softSilenceMs ?? 150
	const maxSegmentMs = options.maxSegmentMs ?? 6_000
	let segmentStart = startedAt
	let lastVoiceAt = startedAt
	let heardVoice = false

	return {
		push(rms, now) {
			if (rms >= voiceRms) {
				heardVoice = true
				lastVoiceAt = now
			}
			const needed = now - segmentStart >= softCutMs ? softSilenceMs : silenceMs
			if (heardVoice && now - lastVoiceAt >= needed) return 'cut'
			if (now - segmentStart >= maxSegmentMs) return heardVoice ? 'cut' : 'discard'
			return null
		},
		hasVoice: () => heardVoice,
		reset(now) {
			segmentStart = now
			lastVoiceAt = now
			heardVoice = false
		},
	}
}

export interface LevelMeter {
	/** Current RMS level of the microphone, 0..1. */
	read: () => number
	close: () => void
}

/**
 * Reads the microphone level through an AnalyserNode. Null where Web Audio is
 * unavailable (or throws), in which case dictation falls back to a single
 * phrase that is transcribed on stop.
 */
export function createLevelMeter(stream: MediaStream): LevelMeter | null {
	if (typeof window === 'undefined') return null
	const Ctor =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
	if (!Ctor) return null
	try {
		const ctx = new Ctor()
		void ctx.resume?.().catch(() => {})
		const analyser = ctx.createAnalyser()
		analyser.fftSize = 1024
		ctx.createMediaStreamSource(stream).connect(analyser)
		const samples = new Float32Array(analyser.fftSize)
		return {
			read() {
				analyser.getFloatTimeDomainData(samples)
				let sum = 0
				for (const sample of samples) sum += sample * sample
				return Math.sqrt(sum / samples.length)
			},
			close() {
				void ctx.close().catch(() => {})
			},
		}
	} catch {
		return null
	}
}
