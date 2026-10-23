import { api } from '@/lib/api'
import {
	type LevelMeter,
	type Segmenter,
	createLevelMeter,
	createSegmenter,
} from '@/lib/speech-segmenter'
import { blobToBase64, blobToWav16k, concatWav } from '@/lib/wav'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

/** Whole-session cap. Each phrase is far smaller than the server's audio limit. */
const MAX_RECORDING_MS = 3 * 60 * 1000
/** How much recent speech one clean-up pass re-reads: enough for a sentence's context, cheap to send. */
const REFINE_WINDOW_MS = 15_000
/** Minimum gap between clean-up requests, so a fast talker is not a request per phrase. */
const REFINE_MIN_GAP_MS = 2_000
/** How often the microphone level is sampled to find pauses between phrases. */
const LEVEL_POLL_MS = 50

export interface Dictation {
	/** False when the browser cannot record audio — render no control at all. */
	supported: boolean
	recording: boolean
	/** Recording has stopped and the last phrases' transcripts are still on the way. */
	transcribing: boolean
	toggle: () => void
}

interface Take {
	recorder: MediaRecorder
	/** Decided when the take is stopped; a take with no speech in it is not sent. */
	voiced: boolean
	startedAt: number
}

/** A stretch of speech and the text that stands for it in the composer right now. */
interface Unit {
	text: string
	wav: Promise<Blob>
	ms: number
}

interface Session {
	stream: MediaStream
	meter: LevelMeter | null
	segmenter: Segmenter | null
	/** The level meter has produced a non-zero reading, so silence is real silence. */
	meterAlive: boolean
	take: Take | null
	finishing: boolean
	/** The last take has stopped and released the microphone. */
	stopped: boolean
	pending: number
	delivered: number
	/**
	 * Speaking order. Joined with spaces they are what the composer received,
	 * unless the user has edited it. A clean-up pass merges its window into one unit.
	 */
	units: Unit[]
	refining: boolean
	/** More speech arrived while a clean-up pass was running. */
	refineDirty: boolean
	lastRefineAt: number
	failed: boolean
	/** Delivers transcripts in speaking order even when requests finish out of order. */
	chain: Promise<void>
	maxTimer: ReturnType<typeof setTimeout> | null
	pollTimer: ReturnType<typeof setInterval> | null
}

/**
 * Records the microphone and streams the transcript into the composer: the
 * recording is cut at pauses in speech, each phrase is transcribed through the
 * server (`POST /transcriptions`, a Voxtral model on OpenRouter) while the
 * user keeps talking, and `onPhrase` is called once per phrase, in order. Tap
 * to start, tap to stop.
 *
 * While the user keeps talking, the last few seconds of speech are transcribed
 * again as one piece, which the model reads with full context, and
 * `onRefine(streamed, refined)` lets the composer swap the streamed text for
 * the cleaner version. The composer owns that swap and must leave the text
 * alone if the user has changed it.
 *
 * Where Web Audio is unavailable the pauses cannot be found, and the whole
 * recording is transcribed in one piece on stop.
 *
 * `supported` is resolved once on mount rather than at module scope: reading
 * `navigator` during import breaks SSR and the jsdom test environment, where
 * the API is absent and the mic must render as nothing rather than a dead
 * control.
 */
export function useDictation(
	onPhrase: (text: string) => void,
	workspaceId: string,
	onRefine?: (streamed: string, refined: string) => void,
): Dictation {
	const [supported, setSupported] = useState(false)
	const [recording, setRecording] = useState(false)
	const [transcribing, setTranscribing] = useState(false)
	const sessionRef = useRef<Session | null>(null)
	// Set on unmount so an in-flight transcript is not delivered to a composer
	// that has gone away.
	const cancelledRef = useRef(false)

	// Keep the latest values without re-creating the recorder, which would
	// drop an in-flight recording on every parent render.
	const onPhraseRef = useRef(onPhrase)
	const onRefineRef = useRef(onRefine)
	const workspaceIdRef = useRef(workspaceId)
	useEffect(() => {
		onPhraseRef.current = onPhrase
		onRefineRef.current = onRefine
		workspaceIdRef.current = workspaceId
	}, [onPhrase, onRefine, workspaceId])

	useEffect(() => {
		setSupported(
			typeof navigator !== 'undefined' &&
				typeof navigator.mediaDevices?.getUserMedia === 'function' &&
				typeof MediaRecorder !== 'undefined',
		)
	}, [])

	const releaseMic = useCallback((session: Session) => {
		if (session.maxTimer) clearTimeout(session.maxTimer)
		if (session.pollTimer) clearInterval(session.pollTimer)
		session.maxTimer = null
		session.pollTimer = null
		session.meter?.close()
		session.meter = null
		for (const track of session.stream.getTracks()) track.stop()
	}, [])

	// Re-transcribes the most recent speech as one piece and swaps it in for the
	// phrases streamed so far. Best effort: the streamed text stays if anything
	// goes wrong.
	const refineOnce = useCallback(async (session: Session) => {
		const units = session.units
		const end = units.length
		let start = end
		let ms = 0
		while (start > 0 && ms + (units[start - 1]?.ms ?? 0) <= REFINE_WINDOW_MS) {
			start--
			ms += units[start]?.ms ?? 0
		}
		// A lone unit has nothing to be read against; an over-long one is final.
		if (end - start < 2) return
		const span = units.slice(start, end)
		const streamed = span.map((unit) => unit.text).join(' ')
		try {
			const wavs = Promise.all(span.map((unit) => unit.wav))
			const { text } = await api.transcriptions.create(workspaceIdRef.current, {
				audio: await blobToBase64(await concatWav(await wavs)),
			})
			if (cancelledRef.current) return
			const refined = text.trim()
			if (!refined) return
			if (refined !== streamed) onRefineRef.current?.(streamed, refined)
			units.splice(start, end - start, {
				text: refined,
				wav: wavs.then(concatWav),
				ms: span.reduce((sum, unit) => sum + unit.ms, 0),
			})
		} catch {
			// Keep what was streamed.
		}
	}, [])

	// One clean-up pass at a time; speech that arrives meanwhile earns another.
	const refine = useCallback(
		async (session: Session) => {
			if (!onRefineRef.current) return
			if (session.refining) {
				session.refineDirty = true
				return
			}
			session.refining = true
			try {
				do {
					session.refineDirty = false
					const wait = session.lastRefineAt + REFINE_MIN_GAP_MS - Date.now()
					if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
					if (cancelledRef.current) return
					session.lastRefineAt = Date.now()
					await refineOnce(session)
				} while (session.refineDirty && !cancelledRef.current)
			} finally {
				session.refining = false
			}
		},
		[refineOnce],
	)

	// Ends the session once the last take has stopped and every phrase has been
	// answered.
	const maybeComplete = useCallback((session: Session) => {
		if (!session.finishing || !session.stopped || session.pending > 0) return
		if (sessionRef.current === session) sessionRef.current = null
		if (cancelledRef.current) return
		setTranscribing(false)
		if (session.delivered === 0 && !session.failed) toast.info('No speech detected')
	}, [])

	const submit = useCallback(
		(session: Session, blob: Blob, ms: number) => {
			session.pending++
			const wavPromise = blobToWav16k(blob)
			const request = (async () => {
				const wav = await wavPromise
				const { text } = await api.transcriptions.create(workspaceIdRef.current, {
					audio: await blobToBase64(wav),
				})
				return text.trim()
			})()
			session.chain = session.chain
				.then(() => request)
				.then(
					(text) => {
						if (cancelledRef.current || !text) return
						session.delivered++
						session.units.push({ text, wav: wavPromise, ms })
						onPhraseRef.current(text)
						void refine(session)
					},
					(err) => {
						session.failed = true
						if (cancelledRef.current) return
						toast.error(err instanceof Error ? err.message : 'Transcription failed')
					},
				)
				.finally(() => {
					session.pending--
					maybeComplete(session)
				})
		},
		[maybeComplete, refine],
	)

	const stopTake = useCallback((session: Session) => {
		const take = session.take
		if (!take || take.recorder.state === 'inactive') return
		// Without a working level meter every take is sent: not hearing speech
		// is then a fault of the meter, not evidence of silence.
		take.voiced = !session.meterAlive || (session.segmenter?.hasVoice() ?? true)
		session.segmenter?.reset(Date.now())
		take.recorder.stop()
	}, [])

	const startTake = useCallback(
		(session: Session) => {
			const recorder = new MediaRecorder(session.stream)
			const take: Take = { recorder, voiced: true, startedAt: Date.now() }
			const chunks: Blob[] = []
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data)
			}
			recorder.onstop = () => {
				if (chunks.length > 0 && take.voiced && !cancelledRef.current) {
					submit(
						session,
						new Blob(chunks, { type: recorder.mimeType }),
						Date.now() - take.startedAt,
					)
				}
				if (session.finishing) {
					releaseMic(session)
					session.stopped = true
					maybeComplete(session)
				} else {
					startTake(session)
				}
			}
			session.take = take
			recorder.start()
		},
		[submit, releaseMic, maybeComplete],
	)

	const finish = useCallback(
		(session: Session) => {
			if (session.finishing) return
			session.finishing = true
			if (session.maxTimer) clearTimeout(session.maxTimer)
			if (session.pollTimer) clearInterval(session.pollTimer)
			session.maxTimer = null
			session.pollTimer = null
			if (!cancelledRef.current) {
				setRecording(false)
				setTranscribing(true)
			}
			// When a cut is already stopping the take, its onstop sees `finishing`
			// and closes the session.
			stopTake(session)
		},
		[stopTake],
	)

	// Stop any live recording when the composer unmounts, otherwise the mic
	// stays hot after navigating away.
	useEffect(() => {
		cancelledRef.current = false
		return () => {
			cancelledRef.current = true
			const session = sessionRef.current
			sessionRef.current = null
			if (!session) return
			finish(session)
			releaseMic(session)
		}
	}, [finish, releaseMic])

	const toggle = useCallback(() => {
		if (transcribing) return
		const active = sessionRef.current
		if (active) {
			finish(active)
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

			const now = Date.now()
			const meter = createLevelMeter(stream)
			const session: Session = {
				stream,
				meter,
				segmenter: meter ? createSegmenter(now) : null,
				meterAlive: false,
				take: null,
				finishing: false,
				stopped: false,
				pending: 0,
				delivered: 0,
				units: [],
				refining: false,
				refineDirty: false,
				lastRefineAt: 0,
				failed: false,
				chain: Promise.resolve(),
				maxTimer: null,
				pollTimer: null,
			}
			sessionRef.current = session
			startTake(session)
			session.maxTimer = setTimeout(() => finish(session), MAX_RECORDING_MS)

			if (meter && session.segmenter) {
				const segmenter = session.segmenter
				session.pollTimer = setInterval(() => {
					const level = meter.read()
					if (level > 0) session.meterAlive = true
					const action = segmenter.push(level, Date.now())
					// `discard` closes a take that held no speech; stopTake leaves it
					// unsent (unless the meter is flat, which proves nothing).
					if (action) stopTake(session)
				}, LEVEL_POLL_MS)
			}
			setRecording(true)
		})()
	}, [transcribing, finish, startTake, stopTake])

	return { supported, recording, transcribing, toggle }
}
