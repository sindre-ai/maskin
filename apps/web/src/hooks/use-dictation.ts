import { api } from '@/lib/api'
import { blobToBase64, blobToWav16k } from '@/lib/wav'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

/** Matches the server's audio size cap (3 min of 16 kHz mono 16-bit WAV). */
const MAX_RECORDING_MS = 3 * 60 * 1000

export interface Dictation {
	/** False when the browser cannot record audio — render no control at all. */
	supported: boolean
	recording: boolean
	/** The recording has stopped and its transcript is on the way. */
	transcribing: boolean
	toggle: () => void
}

/**
 * Records the microphone and transcribes the whole recording on stop through
 * the server (`POST /transcriptions`, a Voxtral model on OpenRouter), calling
 * `onPhrase` once with the transcript. Tap to start, tap to stop.
 *
 * `supported` is resolved once on mount rather than at module scope: reading
 * `navigator` during import breaks SSR and the jsdom test environment, where
 * the API is absent and the mic must render as nothing rather than a dead
 * control.
 */
export function useDictation(onPhrase: (text: string) => void, workspaceId: string): Dictation {
	const [supported, setSupported] = useState(false)
	const [recording, setRecording] = useState(false)
	const [transcribing, setTranscribing] = useState(false)
	const recorderRef = useRef<MediaRecorder | null>(null)
	const streamRef = useRef<MediaStream | null>(null)
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// Set on unmount so an in-flight transcript is not delivered to a composer
	// that has gone away.
	const cancelledRef = useRef(false)

	// Keep the latest callback without re-creating the recorder, which would
	// drop an in-flight recording on every parent render.
	const onPhraseRef = useRef(onPhrase)
	useEffect(() => {
		onPhraseRef.current = onPhrase
	}, [onPhrase])

	useEffect(() => {
		setSupported(
			typeof navigator !== 'undefined' &&
				typeof navigator.mediaDevices?.getUserMedia === 'function' &&
				typeof MediaRecorder !== 'undefined',
		)
	}, [])

	const releaseMic = useCallback(() => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
		timeoutRef.current = null
		for (const track of streamRef.current?.getTracks() ?? []) track.stop()
		streamRef.current = null
	}, [])

	// Stop any live recording when the composer unmounts, otherwise the mic
	// stays hot after navigating away.
	useEffect(() => {
		cancelledRef.current = false
		return () => {
			cancelledRef.current = true
			const recorder = recorderRef.current
			recorderRef.current = null
			if (recorder && recorder.state !== 'inactive') recorder.stop()
			releaseMic()
		}
	}, [releaseMic])

	const transcribe = useCallback(
		async (blob: Blob) => {
			setTranscribing(true)
			try {
				const wav = await blobToWav16k(blob)
				const { text } = await api.transcriptions.create(workspaceId, {
					audio: await blobToBase64(wav),
				})
				if (cancelledRef.current) return
				const transcript = text.trim()
				if (transcript) onPhraseRef.current(transcript)
				else toast.info('No speech detected')
			} catch (err) {
				if (cancelledRef.current) return
				toast.error(err instanceof Error ? err.message : 'Transcription failed')
			} finally {
				if (!cancelledRef.current) setTranscribing(false)
			}
		},
		[workspaceId],
	)

	const toggle = useCallback(() => {
		if (transcribing) return
		const active = recorderRef.current
		if (active) {
			if (active.state !== 'inactive') active.stop()
			return
		}

		void (async () => {
			let stream: MediaStream
			try {
				stream = await navigator.mediaDevices.getUserMedia({ audio: true })
			} catch {
				toast.error('Microphone access was blocked')
				return
			}
			if (cancelledRef.current) {
				for (const track of stream.getTracks()) track.stop()
				return
			}

			const recorder = new MediaRecorder(stream)
			const chunks: Blob[] = []
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data)
			}
			recorder.onstop = () => {
				recorderRef.current = null
				releaseMic()
				setRecording(false)
				if (chunks.length > 0) void transcribe(new Blob(chunks, { type: recorder.mimeType }))
			}

			streamRef.current = stream
			recorderRef.current = recorder
			recorder.start()
			timeoutRef.current = setTimeout(() => {
				if (recorder.state !== 'inactive') recorder.stop()
			}, MAX_RECORDING_MS)
			setRecording(true)
		})()
	}, [transcribing, releaseMic, transcribe])

	return { supported, recording, transcribing, toggle }
}
