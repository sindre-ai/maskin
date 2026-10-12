import { decodeLiveAudioFrame } from '@maskin/shared'
import { describe, expect, it, vi } from 'vitest'
import { createAudioPipeline } from '../../services/live-audio-pipeline'
import { LiveTtsError, parseWavHeader, synthesizeSentence } from '../../services/live-tts'
import type { TtsAudio } from '../../services/live-tts'

function wav(sampleRate: number, channels: number, pcm: Uint8Array): Uint8Array {
	const header = new Uint8Array(44)
	const v = new DataView(header.buffer)
	const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
	w(0, 'RIFF')
	v.setUint32(4, 36 + pcm.length, true)
	w(8, 'WAVE')
	w(12, 'fmt ')
	v.setUint32(16, 16, true)
	v.setUint16(20, 1, true)
	v.setUint16(22, channels, true)
	v.setUint32(24, sampleRate, true)
	v.setUint32(28, sampleRate * channels * 2, true)
	v.setUint16(32, channels * 2, true)
	v.setUint16(34, 16, true)
	w(36, 'data')
	v.setUint32(40, pcm.length, true)
	const out = new Uint8Array(44 + pcm.length)
	out.set(header)
	out.set(pcm, 44)
	return out
}

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0
	return new ReadableStream({
		pull(c) {
			if (i >= chunks.length) return c.close()
			c.enqueue(chunks[i++])
		},
	})
}

const fetchOf = (chunks: Uint8Array[], status = 200): typeof fetch =>
	(async () => new Response(bodyOf(chunks), { status })) as unknown as typeof fetch

const base = {
	apiKey: 'k',
	baseUrl: 'https://openrouter.ai/api/v1',
	model: 'openai/gpt-4o-mini-tts-2025-12-15',
	voice: 'alloy',
	text: 'Hello.',
}

async function drain(a: TtsAudio): Promise<number[]> {
	const out: number[] = []
	for await (const c of a.pcm) out.push(...c)
	return out
}

describe('synthesizeSentence', () => {
	it('treats a body with no header as 24 kHz mono PCM', async () => {
		const audio = await synthesizeSentence({
			...base,
			fetchImpl: fetchOf([new Uint8Array([1, 0, 2, 0])]),
			env: {},
		})
		expect({ r: audio.sampleRate, c: audio.channels }).toEqual({ r: 24000, c: 1 })
		expect(await drain(audio)).toEqual([1, 0, 2, 0])
	})

	it('honours the sample rate override from env', async () => {
		const audio = await synthesizeSentence({
			...base,
			fetchImpl: fetchOf([new Uint8Array([1, 0])]),
			env: { MASKIN_LIVE_TTS_SAMPLE_RATE: '16000' },
		})
		expect(audio.sampleRate).toBe(16000)
	})

	it('strips a RIFF header and reports the real format, even when split across chunks', async () => {
		const file = wav(22050, 1, new Uint8Array([5, 0, 6, 0]))
		const audio = await synthesizeSentence({
			...base,
			fetchImpl: fetchOf([file.slice(0, 20), file.slice(20)]),
		})
		expect(audio.sampleRate).toBe(22050)
		expect(await drain(audio)).toEqual([5, 0, 6, 0])
	})

	it('re-chunks so every chunk holds whole samples', async () => {
		const audio = await synthesizeSentence({
			...base,
			fetchImpl: fetchOf([new Uint8Array([1, 0, 2]), new Uint8Array([0, 3, 0])]),
			env: {},
		})
		const sizes: number[] = []
		for await (const c of audio.pcm) sizes.push(c.length)
		expect(sizes.every((n) => n % 2 === 0)).toBe(true)
		expect(sizes.reduce((a, b) => a + b, 0)).toBe(6)
	})

	it('sends pcm, the voice, and delivery instructions only to models that support them', async () => {
		let sent: Record<string, unknown> = {}
		const f = (async (_u: string, init: RequestInit) => {
			sent = JSON.parse(init.body as string)
			return new Response(bodyOf([new Uint8Array([1, 0])]))
		}) as unknown as typeof fetch
		await synthesizeSentence({ ...base, fetchImpl: f })
		expect(sent.response_format).toBe('pcm')
		expect(sent.voice).toBe('alloy')
		expect(typeof sent.instructions).toBe('string')
		await synthesizeSentence({ ...base, model: 'mistralai/voxtral-mini-tts-2603', fetchImpl: f })
		expect(sent.instructions).toBeUndefined()
	})

	it('raises a typed error with the status on failure', async () => {
		await expect(
			synthesizeSentence({ ...base, fetchImpl: fetchOf([], 402) }),
		).rejects.toMatchObject({ name: 'LiveTtsError', status: 402 })
		await expect(
			synthesizeSentence({ ...base, fetchImpl: fetchOf([], 500) }),
		).rejects.toBeInstanceOf(LiveTtsError)
	})

	it('rejects non 16-bit audio', async () => {
		const f = wav(24000, 1, new Uint8Array(4))
		new DataView(f.buffer).setUint16(34, 8, true)
		await expect(synthesizeSentence({ ...base, fetchImpl: fetchOf([f]) })).rejects.toBeInstanceOf(
			LiveTtsError,
		)
	})
})

describe('parseWavHeader', () => {
	it('returns null for non-RIFF data and incomplete for a short prefix', () => {
		expect(parseWavHeader(new Uint8Array(20))).toBeNull()
		expect(parseWavHeader(new Uint8Array(4))).toBe('incomplete')
	})
})

function audioOf(bytes: number[], sampleRate = 24000): TtsAudio {
	return {
		sampleRate,
		channels: 1,
		bitsPerSample: 16,
		pcm: (async function* () {
			yield new Uint8Array(bytes)
		})(),
	}
}

function io() {
	const events: Array<string | { seq: number; turn: number; len: number }> = []
	return {
		events,
		io: {
			sendJson: (f: Record<string, unknown>) => events.push(String(f.type)),
			sendBinary: (d: Uint8Array) => {
				const f = decodeLiveAudioFrame(d)
				if (f) events.push({ seq: f.header.seq, turn: f.header.turnIndex, len: f.pcm.length })
			},
			waitForDrain: async () => {},
		},
	}
}

describe('createAudioPipeline', () => {
	it('sends audio.start once, frames in order, sentence ends, then audio.end', async () => {
		const { io: sink, events } = io()
		const p = createAudioPipeline({
			turnIndex: 3,
			io: sink,
			signal: new AbortController().signal,
			synthesize: async () => audioOf([1, 0, 2, 0]),
		})
		p.enqueue(0, 'One.')
		p.enqueue(1, 'Two.')
		const r = await p.finish()
		expect(events).toEqual([
			'audio.start',
			{ seq: 0, turn: 3, len: 4 },
			'audio.sentence_end',
			{ seq: 1, turn: 3, len: 4 },
			'audio.sentence_end',
			'audio.end',
		])
		expect(r).toEqual({ lastSeq: 1, characters: 8, failedSentences: 0 })
	})

	it('keeps wire order even when a later sentence finishes synthesising first', async () => {
		const { io: sink, events } = io()
		const resolvers: Array<(a: TtsAudio) => void> = []
		const p = createAudioPipeline({
			turnIndex: 0,
			io: sink,
			signal: new AbortController().signal,
			synthesize: () => new Promise<TtsAudio>((res) => resolvers.push(res)),
		})
		p.enqueue(0, 'First.')
		p.enqueue(1, 'Second.')
		const done = p.finish()
		await vi.waitFor(() => expect(resolvers).toHaveLength(2))
		resolvers[1]?.(audioOf([9, 0]))
		await new Promise((r) => setTimeout(r, 10))
		expect(events).toEqual([]) // nothing leaves until the first sentence is ready
		resolvers[0]?.(audioOf([1, 0]))
		await done
		const lens = events.filter(
			(e): e is { seq: number; turn: number; len: number } => typeof e === 'object',
		)
		expect(lens.map((l) => l.seq)).toEqual([0, 1])
	})

	it('limits synthesis to the prefetch window', async () => {
		const { io: sink } = io()
		let active = 0
		let peak = 0
		const p = createAudioPipeline({
			turnIndex: 0,
			io: sink,
			prefetch: 1,
			signal: new AbortController().signal,
			synthesize: async () => {
				active++
				peak = Math.max(peak, active)
				await new Promise((r) => setTimeout(r, 5))
				active--
				return audioOf([1, 0])
			},
		})
		for (let i = 0; i < 5; i++) p.enqueue(i, `S${i}.`)
		await p.finish()
		expect(peak).toBeLessThanOrEqual(2)
	})

	it('skips a sentence whose synthesis fails and carries on', async () => {
		const { io: sink, events } = io()
		const onErr = vi.fn()
		let n = 0
		const p = createAudioPipeline({
			turnIndex: 0,
			io: sink,
			signal: new AbortController().signal,
			onSentenceError: onErr,
			synthesize: async () => {
				if (n++ === 0) throw new Error('tts down')
				return audioOf([1, 0])
			},
		})
		p.enqueue(0, 'Bad.')
		p.enqueue(1, 'Good.')
		const r = await p.finish()
		expect(onErr).toHaveBeenCalledOnce()
		expect(r.failedSentences).toBe(1)
		expect(events).toContain('audio.end')
	})

	it('sends nothing after abort and no audio.end', async () => {
		const { io: sink, events } = io()
		const ac = new AbortController()
		const p = createAudioPipeline({
			turnIndex: 0,
			io: sink,
			signal: ac.signal,
			synthesize: async () => audioOf([1, 0]),
		})
		p.enqueue(0, 'One.')
		ac.abort()
		await p.finish()
		expect(events).not.toContain('audio.end')
	})

	it('splits a long clip into frames of the configured size', async () => {
		const { io: sink, events } = io()
		const p = createAudioPipeline({
			turnIndex: 0,
			io: sink,
			frameBytes: 4,
			signal: new AbortController().signal,
			synthesize: async () => audioOf([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]),
		})
		p.enqueue(0, 'Long.')
		await p.finish()
		const lens = events
			.filter((e): e is { seq: number; turn: number; len: number } => typeof e === 'object')
			.map((e) => e.len)
		expect(lens).toEqual([4, 4, 2])
	})
})
