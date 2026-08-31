import { useCallback, useEffect, useRef, useState } from 'react'

// Minimal shape of the Web Speech API surface we use. It is not in lib.dom.d.ts
// (the spec is still a draft and Chrome ships it prefixed), so the fields the
// hook touches are declared here rather than pulling in a dependency.
interface SpeechRecognitionAlternativeLike {
	transcript: string
}
interface SpeechRecognitionResultLike {
	readonly isFinal: boolean
	readonly length: number
	[index: number]: SpeechRecognitionAlternativeLike
}
interface SpeechRecognitionEventLike {
	resultIndex: number
	results: {
		readonly length: number
		[index: number]: SpeechRecognitionResultLike
	}
}
interface SpeechRecognitionLike {
	continuous: boolean
	interimResults: boolean
	lang: string
	start(): void
	stop(): void
	abort(): void
	onresult: ((event: SpeechRecognitionEventLike) => void) | null
	onerror: (() => void) | null
	onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
	if (typeof window === 'undefined') return null
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor
		webkitSpeechRecognition?: SpeechRecognitionCtor
	}
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface Dictation {
	/** False when the browser has no SpeechRecognition — render no control at all. */
	supported: boolean
	recording: boolean
	toggle: () => void
}

/**
 * Wraps the browser's SpeechRecognition in a start/stop toggle, calling
 * `onPhrase` once per finalised phrase. Interim results are dropped so the
 * caller only ever appends settled text.
 *
 * `supported` is resolved once on mount rather than at module scope: reading
 * `window` during import breaks SSR and the jsdom test environment, where the
 * API is absent and the mic must render as nothing rather than a dead control.
 */
export function useDictation(onPhrase: (text: string) => void): Dictation {
	const [supported, setSupported] = useState(false)
	const [recording, setRecording] = useState(false)
	const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

	// Keep the latest callback without re-creating the recognition instance,
	// which would drop an in-flight session on every parent render.
	const onPhraseRef = useRef(onPhrase)
	useEffect(() => {
		onPhraseRef.current = onPhrase
	}, [onPhrase])

	useEffect(() => {
		setSupported(getRecognitionCtor() !== null)
	}, [])

	// Stop any live session when the composer unmounts, otherwise the mic stays
	// hot after navigating away.
	useEffect(() => {
		return () => {
			recognitionRef.current?.abort()
			recognitionRef.current = null
		}
	}, [])

	const toggle = useCallback(() => {
		if (recognitionRef.current) {
			recognitionRef.current.stop()
			return
		}

		const Ctor = getRecognitionCtor()
		if (!Ctor) return

		const recognition = new Ctor()
		recognition.continuous = true
		recognition.interimResults = false
		recognition.lang = navigator.language || 'en-US'

		recognition.onresult = (event) => {
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i]
				if (!result?.isFinal) continue
				const transcript = result[0]?.transcript?.trim()
				if (transcript) onPhraseRef.current(transcript)
			}
		}
		// A recognition error (no mic permission, no network for the remote
		// recogniser) ends the session. `onend` fires either way and is where the
		// UI state is reset, so both handlers converge there.
		recognition.onerror = () => {
			recognition.stop()
		}
		recognition.onend = () => {
			recognitionRef.current = null
			setRecording(false)
		}

		try {
			recognition.start()
		} catch {
			// start() throws if a session is already running for this page. Nothing
			// to recover — leave the control idle rather than showing a live mic.
			return
		}
		recognitionRef.current = recognition
		setRecording(true)
	}, [])

	return { supported, recording, toggle }
}
