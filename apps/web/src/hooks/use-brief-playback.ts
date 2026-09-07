import { useCallback, useEffect, useRef, useState } from 'react'

// Words per minute the browser speaks at PLAYBACK_RATE. Used only to turn a
// word count into the duration readout beside the elapsed time —
// SpeechSynthesis exposes no real duration, so this is an estimate and nothing
// else depends on it.
const WORDS_PER_MINUTE = 165

// Slightly under 1. The default is tuned for skimming a page aloud, which is
// a shade fast for a brief you are listening to over coffee.
const PLAYBACK_RATE = 0.95

/**
 * Voice names worth preferring, best first. The default voice on most systems
 * is the oldest and most robotic one installed; every platform ships something
 * better under one of these markers (macOS/iOS "Premium"/"Enhanced"/Siri,
 * Chrome's cloud "Google …" voices, Windows "Natural" voices).
 */
const PREFERRED_VOICE_PATTERNS = [
	/natural/i,
	/premium/i,
	/enhanced/i,
	/neural/i,
	/siri/i,
	/google/i,
]

// Truthiness, not `in` — a test (or a hardening extension) can leave the key
// present but undefined, and calling into that would throw.
function hasSpeechSynthesis(): boolean {
	if (typeof window === 'undefined') return false
	return (
		typeof window.speechSynthesis === 'object' &&
		window.speechSynthesis !== null &&
		typeof window.SpeechSynthesisUtterance === 'function'
	)
}

export function estimateDurationMs(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean).length
	if (words === 0) return 0
	return Math.round((words / (WORDS_PER_MINUTE * PLAYBACK_RATE)) * 60_000)
}

export function formatClock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Pick the least robotic voice available for the user's language.
 *
 * Order: a preferred-name match in the exact language, then any voice in the
 * exact language, then a preferred-name match in the same base language
 * ("en-GB" for an "en-US" user), then any same-language voice, then the
 * browser's own default. Returning null means "leave `utterance.voice` unset",
 * which is what the browser does anyway.
 */
export function pickVoice(
	voices: SpeechSynthesisVoice[],
	language = 'en-US',
): SpeechSynthesisVoice | null {
	if (voices.length === 0) return null
	const preferred = (voice: SpeechSynthesisVoice) =>
		PREFERRED_VOICE_PATTERNS.some((pattern) => pattern.test(voice.name))
	const base = language.split('-')[0]?.toLowerCase() ?? 'en'
	const exact = voices.filter((v) => v.lang.toLowerCase() === language.toLowerCase())
	const sameBase = voices.filter((v) => v.lang.toLowerCase().startsWith(base))

	return (
		exact.find(preferred) ??
		exact[0] ??
		sameBase.find(preferred) ??
		sameBase[0] ??
		voices.find((v) => v.default) ??
		null
	)
}

/**
 * Split the script into utterance-sized chunks on sentence boundaries.
 *
 * Two reasons this is not one big utterance. Chrome silently truncates long
 * ones (the long-standing ~15s cutoff), and `onboundary` never fires on some
 * platforms — so per-sentence utterances are both the reliability fix and the
 * only progress signal that works everywhere. Sentences also give the voice
 * its natural resets: it re-pitches at the start of each one.
 */
export function splitIntoUtterances(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0)
}

export interface BriefPlayback {
	/** False when the browser has no SpeechSynthesis — the caller renders no
	 *  player at all rather than a play button that does nothing. */
	supported: boolean
	playing: boolean
	/** 0–1. Sentences completed plus the current sentence's own `boundary`
	 *  progress, weighted by length, so it advances smoothly and still tracks
	 *  real speech on platforms that never fire `boundary`. */
	progress: number
	elapsedMs: number
	/** Word-count estimate — see WORDS_PER_MINUTE. */
	estimatedTotalMs: number
	toggle: () => void
	stop: () => void
}

/**
 * Speaks the brief through the Web Speech API's SpeechSynthesis — the mirror
 * of `useDictation`'s SpeechRecognition, and the only playback path the app
 * has: `POST /briefing/spoken` returns a script and nothing else (no audio
 * asset, no server-side TTS).
 *
 * How human it sounds is mostly decided before it gets here — the script is
 * written as spoken prose, so the punctuation carries the pauses — but the
 * three levers this hook owns (which voice, how fast, and speaking a sentence
 * at a time) are the difference between a person and a screen reader.
 */
export function useBriefPlayback(text: string): BriefPlayback {
	const [supported] = useState(hasSpeechSynthesis)
	const [playing, setPlaying] = useState(false)
	const [progress, setProgress] = useState(0)
	const [elapsedMs, setElapsedMs] = useState(0)
	const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
	// Guards the async queue: every utterance callback checks it still owns
	// playback, so a stop() mid-script can't be resurrected by an in-flight
	// `onend` starting the next sentence.
	const runIdRef = useRef(0)
	const startedAtRef = useRef<number | null>(null)

	// getVoices() returns [] until the list loads, and fires `voiceschanged`
	// when it does — reading it once at mount is the classic way to end up
	// with the default robotic voice forever.
	// Every member is probed before it is called: `speechSynthesis` is a host
	// object a hardening extension (or a test stub) can leave half-implemented,
	// and voice selection is the one lever here that is pure polish — losing it
	// must degrade to the browser's default voice, never take the card down.
	useEffect(() => {
		const synth = hasSpeechSynthesis() ? window.speechSynthesis : null
		if (!synth || typeof synth.getVoices !== 'function') return
		const load = () => setVoices(synth.getVoices())
		load()
		if (typeof synth.addEventListener !== 'function') return
		synth.addEventListener('voiceschanged', load)
		return () => synth.removeEventListener?.('voiceschanged', load)
	}, [])

	const stop = useCallback(() => {
		runIdRef.current += 1
		startedAtRef.current = null
		setPlaying(false)
		setProgress(0)
		setElapsedMs(0)
		if (!hasSpeechSynthesis()) return
		window.speechSynthesis.cancel()
	}, [])

	// Cancels on unmount. Note this fires when the *hook owner* unmounts, which
	// is not the same as the drawer closing — a caller that stays mounted across
	// open/close must call `stop` itself when it closes (BriefDrawer does).
	useEffect(() => stop, [stop])

	// A new brief invalidates whatever is being spoken.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the text identity should reset playback
	useEffect(() => stop, [text, stop])

	useEffect(() => {
		if (!playing) return
		const interval = setInterval(() => {
			if (startedAtRef.current === null) return
			setElapsedMs(Date.now() - startedAtRef.current)
		}, 250)
		return () => clearInterval(interval)
	}, [playing])

	const toggle = useCallback(() => {
		if (!hasSpeechSynthesis()) return
		if (playing) {
			stop()
			return
		}
		const spoken = text.trim()
		if (spoken.length === 0) return
		const chunks = splitIntoUtterances(spoken)
		if (chunks.length === 0) return

		// Cancel anything queued from a previous run before starting.
		window.speechSynthesis.cancel()
		runIdRef.current += 1
		const runId = runIdRef.current

		const voice = pickVoice(voices, typeof navigator === 'undefined' ? 'en-US' : navigator.language)
		const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0)

		const finish = () => {
			if (runIdRef.current !== runId) return
			startedAtRef.current = null
			setPlaying(false)
			setProgress(0)
			setElapsedMs(0)
		}

		const speakFrom = (index: number, charsSpoken: number) => {
			if (runIdRef.current !== runId) return
			const chunk = chunks[index]
			if (chunk === undefined) {
				finish()
				return
			}
			const utterance = new window.SpeechSynthesisUtterance(chunk)
			if (voice) utterance.voice = voice
			utterance.rate = PLAYBACK_RATE
			utterance.pitch = 1
			utterance.onboundary = (event) => {
				if (runIdRef.current !== runId) return
				const within = typeof event.charIndex === 'number' ? event.charIndex : 0
				setProgress(Math.min(1, (charsSpoken + within) / totalChars))
			}
			utterance.onend = () => {
				if (runIdRef.current !== runId) return
				setProgress(Math.min(1, (charsSpoken + chunk.length) / totalChars))
				speakFrom(index + 1, charsSpoken + chunk.length)
			}
			// An error mid-script ends playback rather than skipping ahead — a
			// brief that silently drops a sentence is worse than one that stops.
			utterance.onerror = finish
			window.speechSynthesis.speak(utterance)
		}

		startedAtRef.current = Date.now()
		setProgress(0)
		setElapsedMs(0)
		setPlaying(true)
		speakFrom(0, 0)
	}, [playing, stop, text, voices])

	return {
		supported,
		playing,
		progress,
		elapsedMs,
		estimatedTotalMs: estimateDurationMs(text),
		toggle,
		stop,
	}
}
