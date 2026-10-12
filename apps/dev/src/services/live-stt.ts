/**
 * Speech-to-text through OpenRouter's `POST /audio/transcriptions`. Batch only:
 * one request returns the whole transcript, with no partial results. iPhone
 * transcribes on-device and sends text; this exists for clients that cannot
 * (web, unsupported locales) and for the smoke script's TTS-to-STT round trip.
 */

export class LiveSttError extends Error {
	readonly status?: number
	constructor(message: string, status?: number) {
		super(message)
		this.name = 'LiveSttError'
		this.status = status
	}
}

/** Wraps raw little-endian PCM16 in a minimal WAV container so providers can read it. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
	const out = new Uint8Array(44 + pcm.length)
	const v = new DataView(out.buffer)
	const tag = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
	}
	tag(0, 'RIFF')
	v.setUint32(4, 36 + pcm.length, true)
	tag(8, 'WAVE')
	tag(12, 'fmt ')
	v.setUint32(16, 16, true)
	v.setUint16(20, 1, true) // PCM
	v.setUint16(22, channels, true)
	v.setUint32(24, sampleRate, true)
	v.setUint32(28, sampleRate * channels * 2, true)
	v.setUint16(32, channels * 2, true)
	v.setUint16(34, 16, true)
	tag(36, 'data')
	v.setUint32(40, pcm.length, true)
	out.set(pcm, 44)
	return out
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

export interface TranscribeParams {
	apiKey: string
	baseUrl: string
	model: string
	audio: Uint8Array
	format: 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg' | 'webm' | 'aac'
	language?: string
	signal?: AbortSignal
	fetchImpl?: typeof fetch
}

export interface Transcription {
	text: string
	seconds: number | null
	costUsd: number | null
}

export async function transcribeAudio(p: TranscribeParams): Promise<Transcription> {
	const res = await (p.fetchImpl ?? fetch)(`${p.baseUrl}/audio/transcriptions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
		body: JSON.stringify({
			model: p.model,
			// Raw base64 bytes, not a data: URI.
			input_audio: { data: toBase64(p.audio), format: p.format },
			...(p.language && { language: p.language }),
		}),
		signal: p.signal,
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new LiveSttError(
			`OpenRouter transcription error: ${res.status} ${text.slice(0, 300)}`,
			res.status,
		)
	}
	const json = (await res.json()) as {
		text?: unknown
		usage?: { seconds?: unknown; cost?: unknown }
	}
	if (typeof json.text !== 'string')
		throw new LiveSttError('OpenRouter transcription returned no text')
	return {
		text: json.text.trim(),
		seconds: typeof json.usage?.seconds === 'number' ? json.usage.seconds : null,
		costUsd: typeof json.usage?.cost === 'number' ? json.usage.cost : null,
	}
}
