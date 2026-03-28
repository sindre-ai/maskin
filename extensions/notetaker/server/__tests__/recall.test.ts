import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { createBot, getBot, downloadRecording } = await import('../services/recall.js')

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

describe('Recall.ai client', () => {
	beforeEach(() => {
		mockFetch.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('createBot', () => {
		it('sends POST with meeting_url', async () => {
			const bot = { id: 'bot-1', meeting_url: 'https://meet.google.com/abc' }
			mockFetch.mockResolvedValueOnce(jsonResponse(bot))

			const result = await createBot('https://meet.google.com/abc')

			expect(result).toEqual(bot)
			const call = mockFetch.mock.calls[0] as [string, RequestInit]
			expect(call[0]).toContain('/bot')
			expect(call[1].method).toBe('POST')
			const body = JSON.parse(call[1].body as string)
			expect(body.meeting_url).toBe('https://meet.google.com/abc')
		})

		it('includes botName and joinAt when provided', async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'bot-2' }))

			await createBot('https://zoom.us/j/123', {
				botName: 'Maskin Notetaker',
				joinAt: '2026-03-28T15:00:00Z',
			})

			const call = mockFetch.mock.calls[0] as [string, RequestInit]
			const body = JSON.parse(call[1].body as string)
			expect(body.bot_name).toBe('Maskin Notetaker')
			expect(body.join_at).toBe('2026-03-28T15:00:00Z')
		})

		it('throws on API error', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))

			await expect(createBot('https://meet.google.com/abc')).rejects.toThrow(
				'Recall API error (403)',
			)
		})
	})

	describe('getBot', () => {
		it('fetches bot by ID', async () => {
			const bot = { id: 'bot-1', video_url: 'https://api.recall.ai/recording' }
			mockFetch.mockResolvedValueOnce(jsonResponse(bot))

			const result = await getBot('bot-1')

			expect(result).toEqual(bot)
			const call = mockFetch.mock.calls[0] as [string, RequestInit]
			expect(call[0]).toContain('/bot/bot-1')
		})

		it('throws on 404', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

			await expect(getBot('nonexistent')).rejects.toThrow('Recall API error (404)')
		})
	})

	describe('downloadRecording', () => {
		it('downloads audio as Buffer', async () => {
			const audioData = new Uint8Array([1, 2, 3, 4])
			mockFetch.mockResolvedValueOnce(new Response(audioData))

			const result = await downloadRecording('https://api.recall.ai/recording')

			expect(Buffer.isBuffer(result)).toBe(true)
			expect(result.length).toBe(4)
		})

		it('throws on download failure', async () => {
			mockFetch.mockResolvedValueOnce(new Response('Error', { status: 500 }))

			await expect(downloadRecording('https://api.recall.ai/recording')).rejects.toThrow(
				'Failed to download recording (500)',
			)
		})
	})
})
