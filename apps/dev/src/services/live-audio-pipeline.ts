import { LIVE_AUDIO_KIND_ASSISTANT, encodeLiveAudioFrame } from '@maskin/shared'
import type { TtsAudio } from './live-tts'

/**
 * Turns sentences into ordered audio frames on the wire.
 *
 * Synthesis of upcoming sentences starts while an earlier one is still
 * streaming (up to `prefetch` ahead), so the gap between sentences is the time
 * to the first byte of an already-requested clip rather than a fresh round
 * trip. Bytes still go out strictly in sentence order.
 */

export const FRAME_BYTES = 32 * 1024

export interface AudioPipelineIO {
	sendJson(frame: Record<string, unknown>): void
	sendBinary(data: Uint8Array): void
	/** Resolves when the socket can take more data; rejects if it stalls. */
	waitForDrain(): Promise<void>
}

export interface AudioPipelineParams {
	turnIndex: number
	io: AudioPipelineIO
	synthesize(text: string, signal: AbortSignal): Promise<TtsAudio>
	signal: AbortSignal
	prefetch?: number
	frameBytes?: number
	onFirstAudio?: () => void
	/** A sentence's audio has been fully sent; `lastSeq` is its final frame. Lets an interrupt work out what was heard. */
	onSentenceEnd?: (sentenceIndex: number, lastSeq: number) => void
	onSentenceError?: (err: unknown, sentenceIndex: number) => void
}

interface Job {
	index: number
	text: string
	audio: Promise<TtsAudio> | null
}

export interface AudioPipeline {
	enqueue(sentenceIndex: number, text: string): void
	/** No more sentences are coming. Resolves once every queued sentence has been sent. */
	finish(): Promise<{ lastSeq: number; characters: number; failedSentences: number }>
}

export function createAudioPipeline(p: AudioPipelineParams): AudioPipeline {
	const prefetch = p.prefetch ?? 2
	const frameBytes = p.frameBytes ?? FRAME_BYTES
	const jobs: Job[] = []
	let sendIndex = 0
	let inflight = 0
	let closed = false
	let seq = 0
	let started = false
	let characters = 0
	let failed = 0
	let wake: (() => void) | null = null
	let firstAudioSent = false

	const notify = () => {
		const w = wake
		wake = null
		w?.()
	}

	function startJob(job: Job) {
		if (job.audio) return
		inflight++
		job.audio = p.synthesize(job.text, p.signal)
		characters += job.text.length
		const done = () => {
			inflight--
			pump()
		}
		job.audio.then(done, done)
	}

	/** Starts synthesis for queued jobs, nearest first, up to the prefetch window. */
	function pump() {
		for (let i = sendIndex; i < jobs.length && inflight < prefetch + 1; i++) {
			const job = jobs[i]
			if (job) startJob(job)
		}
	}

	async function streamJob(job: Job): Promise<void> {
		const audio = await (job.audio as Promise<TtsAudio>)
		if (!started) {
			started = true
			p.io.sendJson({
				type: 'audio.start',
				turn_index: p.turnIndex,
				format: 'pcm_s16le',
				sample_rate: audio.sampleRate,
				channels: audio.channels,
				bits_per_sample: 16,
			})
		}
		for await (const chunk of audio.pcm) {
			if (p.signal.aborted) return
			for (let o = 0; o < chunk.length; o += frameBytes) {
				if (p.signal.aborted) return
				await p.io.waitForDrain()
				p.io.sendBinary(
					encodeLiveAudioFrame(
						{ kind: LIVE_AUDIO_KIND_ASSISTANT, turnIndex: p.turnIndex, seq },
						chunk.subarray(o, o + frameBytes),
					),
				)
				seq++
				if (!firstAudioSent) {
					firstAudioSent = true
					p.onFirstAudio?.()
				}
			}
		}
		const lastSeq = Math.max(0, seq - 1)
		p.io.sendJson({
			type: 'audio.sentence_end',
			turn_index: p.turnIndex,
			sentence_index: job.index,
			last_seq: lastSeq,
		})
		p.onSentenceEnd?.(job.index, lastSeq)
	}

	const runner = (async () => {
		while (true) {
			if (p.signal.aborted) return
			const job = jobs[sendIndex]
			if (!job) {
				if (closed) return
				await new Promise<void>((resolve) => {
					wake = resolve
				})
				continue
			}
			startJob(job)
			try {
				await streamJob(job)
			} catch (err) {
				if (p.signal.aborted) return
				failed++
				p.onSentenceError?.(err, job.index)
			}
			sendIndex++
			pump()
		}
	})()

	return {
		enqueue(sentenceIndex, text) {
			if (closed) return
			jobs.push({ index: sentenceIndex, text, audio: null })
			pump()
			notify()
		},
		async finish() {
			closed = true
			notify()
			await runner
			if (started && !p.signal.aborted) {
				p.io.sendJson({
					type: 'audio.end',
					turn_index: p.turnIndex,
					last_seq: Math.max(0, seq - 1),
				})
			}
			return { lastSeq: Math.max(0, seq - 1), characters, failedSentences: failed }
		},
	}
}
