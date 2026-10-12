import { describe, expect, it } from 'vitest'
import { LiveSttError, pcm16ToWav, transcribeAudio } from '../../services/live-stt'
import { parseWavHeader } from '../../services/live-tts'

describe('pcm16ToWav', () => {
	it('produces a header that the TTS reader parses back to the same format', () => {
		const wav = pcm16ToWav(new Uint8Array([1, 0, 2, 0]), 22050, 1)
		expect(wav.length).toBe(48)
		const info = parseWavHeader(wav)
		expect(info).toMatchObject({
			sampleRate: 22050,
			channels: 1,
			bitsPerSample: 16,
			dataOffset: 44,
		})
	})
})

describe('transcribeAudio', () => {
	const base = {
		apiKey: 'k',
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'm',
		audio: new Uint8Array([1, 2]),
		format: 'wav' as const,
	}

	it('sends base64 input_audio and reads text and usage', async () => {
		let sent: Record<string, unknown> = {}
		const f = (async (_u: string, init: RequestInit) => {
			sent = JSON.parse(init.body as string)
			return new Response(
				JSON.stringify({ text: ' hello there ', usage: { seconds: 2, cost: 0.001 } }),
				{ status: 200 },
			)
		}) as unknown as typeof fetch
		const r = await transcribeAudio({ ...base, language: 'en', fetchImpl: f })
		expect(r).toEqual({ text: 'hello there', seconds: 2, costUsd: 0.001 })
		expect(sent.input_audio).toEqual({ data: 'AQI=', format: 'wav' })
		expect(sent.language).toBe('en')
	})

	it('raises a typed error on failure and when no text comes back', async () => {
		const bad = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch
		await expect(transcribeAudio({ ...base, fetchImpl: bad })).rejects.toMatchObject({
			name: 'LiveSttError',
			status: 429,
		})
		const empty = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
		await expect(transcribeAudio({ ...base, fetchImpl: empty })).rejects.toBeInstanceOf(
			LiveSttError,
		)
	})
})
