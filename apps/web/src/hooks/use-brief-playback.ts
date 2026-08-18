import { useCallback, useEffect, useRef, useState } from 'react'

// Words per minute the browser speaks at rate 1. Used only to turn a word
// count into the duration readout beside the elapsed time — SpeechSynthesis
// exposes no real duration, so this is an estimate and nothing else depends
// on it.
const WORDS_PER_MINUTE = 170

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
	return Math.round((words / WORDS_PER_MINUTE) * 60_000)
}

export function formatClock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export interface BriefPlayback {
	/** False when the browser has no SpeechSynthesis — the caller renders no
	 *  player at all rather than a play button that does nothing. */
	supported: boolean
	playing: boolean
	/** 0–1, driven by the utterance's own `boundary` events (charIndex over
	 *  the spoken text length), so it tracks real speech progress. */
	progress: number
	elapsedMs: number
	/** Word-count estimate — see WORDS_PER_MINUTE. */
	estimatedTotalMs: number
	toggle: () => void
	stop: () => void
}

/**
 * Speaks the brief through the Web Speech API's SpeechSynthesis — the mirror
 * of `useDictation`'s SpeechRecognition, and the only real playback path the
 * app has: `GET /briefing` returns markdown and nothing else (no audio asset,
 * no server-side TTS).
 */
export function useBriefPlayback(text: string): BriefPlayback {
	const [supported] = useState(hasSpeechSynthesis)
	const [playing, setPlaying] = useState(false)
	const [progress, setProgress] = useState(0)
	const [elapsedMs, setElapsedMs] = useState(0)
	const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
	const startedAtRef = useRef<number | null>(null)

	const stop = useCallback(() => {
		if (!hasSpeechSynthesis()) return
		window.speechSynthesis.cancel()
		utteranceRef.current = null
		startedAtRef.current = null
		setPlaying(false)
		setProgress(0)
		setElapsedMs(0)
	}, [])

	// Speech keeps running after the drawer closes unless it's cancelled here.
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
		if (utteranceRef.current) {
			stop()
			return
		}
		const spoken = text.trim()
		if (spoken.length === 0) return
		const utterance = new SpeechSynthesisUtterance(spoken)
		utterance.onboundary = (event) => {
			const index = typeof event.charIndex === 'number' ? event.charIndex : 0
			setProgress(Math.min(1, index / spoken.length))
		}
		const finish = () => {
			utteranceRef.current = null
			startedAtRef.current = null
			setPlaying(false)
			setProgress(0)
			setElapsedMs(0)
		}
		utterance.onend = finish
		utterance.onerror = finish
		utteranceRef.current = utterance
		startedAtRef.current = Date.now()
		setProgress(0)
		setElapsedMs(0)
		setPlaying(true)
		window.speechSynthesis.speak(utterance)
	}, [stop, text])

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
