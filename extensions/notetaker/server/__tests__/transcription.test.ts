import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock fetch globally before importing the module
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock audio converter — passthrough buffer, single chunk
vi.mock('../services/audio-converter.js', () => ({
	convertToWav: vi.fn(async (buf: Buffer) => buf),
	splitWavIntoChunks: vi.fn(async (buf: Buffer) => [{ buffer: buf, offsetSeconds: 0 }]),
}))

// Dynamic import so the module picks up the mocked fetch
const { transcribe, checkWhisperHealth } = await import('../services/transcription.js')

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

const sampleResult = {
	text: 'Hello world',
	language: 'en',
	segments: [{ start: 0, end: 1.5, text: 'Hello world' }],
}

describe('transcribe', () => {
	beforeEach(() => {
		mockFetch.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns transcription result on success', async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse(sampleResult))

		const result = await transcribe(Buffer.from('audio'), 'test.wav')

		expect(result).toEqual(sampleResult)
		expect(mockFetch).toHaveBeenCalledTimes(1)
		const call = mockFetch.mock.calls[0] as [string, RequestInit]
		expect(call[0]).toBe('http://127.0.0.1:8080/inference')
		expect(call[1].method).toBe('POST')
		expect(call[1].body).toBeInstanceOf(FormData)
	})

	it('passes language option when provided', async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse(sampleResult))

		await transcribe(Buffer.from('audio'), 'test.wav', { language: 'no' })

		const call = mockFetch.mock.calls[0] as [string, RequestInit]
		const form = call[1].body as FormData
		expect(form.get('language')).toBe('no')
	})

	it('retries on 5xx errors with exponential backoff', async () => {
		mockFetch
			.mockResolvedValueOnce(jsonResponse({ error: 'overloaded' }, 503))
			.mockResolvedValueOnce(jsonResponse({ error: 'still busy' }, 500))
			.mockResolvedValueOnce(jsonResponse(sampleResult))

		const result = await transcribe(Buffer.from('audio'), 'test.wav')

		expect(result).toEqual(sampleResult)
		expect(mockFetch).toHaveBeenCalledTimes(3)
	})

	it('throws after exhausting retries on 5xx', async () => {
		mockFetch.mockResolvedValue(jsonResponse({ error: 'down' }, 500))

		await expect(transcribe(Buffer.from('audio'), 'test.wav')).rejects.toThrow(
			'Transcription failed: 500',
		)
		expect(mockFetch).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
	})

	it('throws immediately on 4xx errors without retrying', async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, 400))

		await expect(transcribe(Buffer.from('audio'), 'test.wav')).rejects.toThrow(
			'Transcription failed: 400',
		)
		expect(mockFetch).toHaveBeenCalledTimes(1)
	})

	it('retries on connection errors (TypeError)', async () => {
		mockFetch
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce(jsonResponse(sampleResult))

		const result = await transcribe(Buffer.from('audio'), 'test.wav')

		expect(result).toEqual(sampleResult)
		expect(mockFetch).toHaveBeenCalledTimes(2)
	})
})

describe('checkWhisperHealth', () => {
	beforeEach(() => {
		mockFetch.mockReset()
	})

	it('returns true when server responds OK', async () => {
		mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))

		expect(await checkWhisperHealth()).toBe(true)
	})

	it('returns false when server responds with error', async () => {
		mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }))

		expect(await checkWhisperHealth()).toBe(false)
	})

	it('returns false when server is unreachable', async () => {
		mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

		expect(await checkWhisperHealth()).toBe(false)
	})
})
