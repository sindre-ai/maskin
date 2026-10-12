import { logger } from '../lib/logger'

/**
 * Text-to-speech through OpenRouter's OpenAI-compatible `POST /audio/speech`.
 *
 * The docs list `mp3` and `pcm` as formats and do not state the PCM sample rate,
 * which differs by upstream model. So: ask for `pcm`, assume 24 kHz mono 16-bit
 * (override with MASKIN_LIVE_TTS_SAMPLE_RATE), and sniff the first bytes for a
 * RIFF/WAVE header in case a provider wraps the audio anyway. scripts/live-smoke.ts
 * prints what each allowed model really returns; do not offer a model it has not
 * been run against.
 */

export interface TtsAudio {
	sampleRate: number
	channels: number
	bitsPerSample: 16
	/** Raw little-endian PCM16 chunks, always an even number of bytes. */
	pcm: AsyncGenerator<Uint8Array>
}

export class LiveTtsError extends Error {
	readonly status?: number
	constructor(message: string, status?: number) {
		super(message)
		this.name = 'LiveTtsError'
		this.status = status
	}
}

/** Models known to honour the `instructions` (delivery) field. */
const MODELS_WITH_INSTRUCTIONS = /^(openai\/gpt-4o-mini-tts|google\/gemini-.*tts)/i

export const SPOKEN_REGISTER_HINT =
	'Speak naturally and warmly, at a conversational pace, like a colleague talking, not reading.'

export interface SynthesizeParams {
	apiKey: string
	baseUrl: string
	model: string
	voice: string
	text: string
	signal?: AbortSignal
	fetchImpl?: typeof fetch
	env?: NodeJS.ProcessEnv
}

function defaultSampleRate(env: NodeJS.ProcessEnv): number {
	const n = Number(env.MASKIN_LIVE_TTS_SAMPLE_RATE)
	return Number.isInteger(n) && n >= 8000 && n <= 48000 ? n : 24000
}

interface WavInfo {
	sampleRate: number
	channels: number
	bitsPerSample: number
	dataOffset: number
}

/** Parses a RIFF/WAVE header from the start of `buf`; null if it is not one or is incomplete. */
export function parseWavHeader(buf: Uint8Array): WavInfo | null | 'incomplete' {
	if (buf.length < 12) return 'incomplete'
	const tag = (o: number) =>
		String.fromCharCode(buf[o] ?? 0, buf[o + 1] ?? 0, buf[o + 2] ?? 0, buf[o + 3] ?? 0)
	if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	let offset = 12
	let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null
	while (offset + 8 <= buf.length) {
		const id = tag(offset)
		const size = view.getUint32(offset + 4, true)
		if (id === 'fmt ') {
			if (offset + 8 + 16 > buf.length) return 'incomplete'
			fmt = {
				channels: view.getUint16(offset + 10, true),
				sampleRate: view.getUint32(offset + 12, true),
				bitsPerSample: view.getUint16(offset + 22, true),
			}
		} else if (id === 'data') {
			if (!fmt) return null
			return { ...fmt, dataOffset: offset + 8 }
		}
		offset += 8 + size + (size % 2)
	}
	return 'incomplete'
}

/** Re-chunks a byte stream so every yielded chunk holds whole 16-bit samples. */
async function* evenChunks(
	source: AsyncIterable<Uint8Array>,
	first?: Uint8Array,
): AsyncGenerator<Uint8Array> {
	let carry: number | null = null
	const emit = function* (chunk: Uint8Array): Generator<Uint8Array> {
		let data = chunk
		if (carry !== null) {
			const merged = new Uint8Array(data.length + 1)
			merged[0] = carry
			merged.set(data, 1)
			data = merged
			carry = null
		}
		if (data.length % 2 === 1) {
			carry = data[data.length - 1] ?? 0
			data = data.subarray(0, data.length - 1)
		}
		if (data.length > 0) yield data
	}
	if (first && first.length > 0) yield* emit(first)
	for await (const chunk of source) yield* emit(chunk)
}

async function* readBody(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
	const reader = body.getReader()
	const onAbort = () => reader.cancel().catch(() => {})
	signal?.addEventListener('abort', onAbort, { once: true })
	try {
		while (true) {
			if (signal?.aborted) return
			const { done, value } = await reader.read()
			if (done) return
			if (value && value.length > 0) yield value
		}
	} finally {
		signal?.removeEventListener('abort', onAbort)
		reader.releaseLock?.()
	}
}

export async function synthesizeSentence(p: SynthesizeParams): Promise<TtsAudio> {
	const env = p.env ?? process.env
	const body: Record<string, unknown> = {
		model: p.model,
		input: p.text,
		voice: p.voice,
		response_format: 'pcm',
	}
	if (MODELS_WITH_INSTRUCTIONS.test(p.model)) body.instructions = SPOKEN_REGISTER_HINT

	const res = await (p.fetchImpl ?? fetch)(`${p.baseUrl}/audio/speech`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
		body: JSON.stringify(body),
		signal: p.signal,
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		logger.warn('live tts request failed', { model: p.model, status: res.status })
		throw new LiveTtsError(
			`OpenRouter speech error: ${res.status} ${text.slice(0, 300)}`,
			res.status,
		)
	}
	if (!res.body) throw new LiveTtsError('OpenRouter speech returned no body', res.status)

	const chunks = readBody(res.body, p.signal)
	// Gather the first bytes so a RIFF header, if present, can be recognised and removed.
	let head = new Uint8Array(0)
	let info: WavInfo | null | 'incomplete' = 'incomplete'
	let ended = false
	while (info === 'incomplete' && head.length < 4096) {
		const next = await chunks.next()
		if (next.done) {
			ended = true
			break
		}
		const merged = new Uint8Array(head.length + next.value.length)
		merged.set(head)
		merged.set(next.value, head.length)
		head = merged
		info = parseWavHeader(head)
	}
	if (info === 'incomplete') info = null // too short or never completed: treat as raw PCM

	if (info) {
		if (info.bitsPerSample !== 16) {
			throw new LiveTtsError(`Unsupported TTS sample size: ${info.bitsPerSample} bits`)
		}
		return {
			sampleRate: info.sampleRate,
			channels: info.channels,
			bitsPerSample: 16,
			pcm: evenChunks(ended ? emptyStream() : chunks, head.subarray(info.dataOffset)),
		}
	}
	return {
		sampleRate: defaultSampleRate(env),
		channels: 1,
		bitsPerSample: 16,
		pcm: evenChunks(ended ? emptyStream() : chunks, head),
	}
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {}
