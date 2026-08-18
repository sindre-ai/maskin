import { useCallback, useEffect, useRef, useState } from 'react'

// Minimal structural types for the Web Speech API — it isn't in TS's DOM lib
// and only Chromium/Safari ship it (behind the webkit prefix on Safari).
interface SpeechRecognitionAlternativeLike {
	transcript: string
}
interface SpeechRecognitionResultLike {
	isFinal: boolean
	0: SpeechRecognitionAlternativeLike
}
interface SpeechRecognitionEventLike {
	resultIndex: number
	results: { length: number } & Record<number, SpeechRecognitionResultLike>
}
interface SpeechRecognitionLike {
	continuous: boolean
	interimResults: boolean
	lang: string
	start(): void
	stop(): void
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
	/** False when the browser has no SpeechRecognition — the caller should
	 *  render nothing at all rather than a disabled control (mockup 8066). */
	supported: boolean
	recording: boolean
	start: () => void
	stop: () => void
	toggle: () => void
}

/**
 * Composer dictation. Emits each finalised phrase through `onTranscript` so the
 * caller decides how to fold it into its own draft; interim results are
 * ignored, which keeps the textarea from flickering mid-word.
 */
export function useDictation(onTranscript: (text: string) => void): Dictation {
	const [supported] = useState(() => getRecognitionCtor() !== null)
	const [recording, setRecording] = useState(false)
	const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
	// Kept in a ref so restarting dictation never rebinds the recogniser.
	const onTranscriptRef = useRef(onTranscript)
	onTranscriptRef.current = onTranscript

	useEffect(() => {
		return () => {
			recognitionRef.current?.stop()
			recognitionRef.current = null
		}
	}, [])

	const start = useCallback(() => {
		const Ctor = getRecognitionCtor()
		if (!Ctor || recognitionRef.current) return
		const recognition = new Ctor()
		recognition.continuous = true
		recognition.interimResults = false
		recognition.lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US'
		recognition.onresult = (event) => {
			let text = ''
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i]
				if (result?.isFinal) text += result[0].transcript
			}
			if (text.trim().length > 0) onTranscriptRef.current(text)
		}
		recognition.onerror = () => {
			recognitionRef.current = null
			setRecording(false)
		}
		recognition.onend = () => {
			recognitionRef.current = null
			setRecording(false)
		}
		recognitionRef.current = recognition
		recognition.start()
		setRecording(true)
	}, [])

	const stop = useCallback(() => {
		recognitionRef.current?.stop()
		recognitionRef.current = null
		setRecording(false)
	}, [])

	const toggle = useCallback(() => {
		if (recognitionRef.current) stop()
		else start()
	}, [start, stop])

	return { supported, recording, start, stop, toggle }
}
