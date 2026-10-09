import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BodyFetchTerminalError,
	MAX_ATTEMPTS,
	fetchResendBodyWithRetry,
} from '../../../../../lib/integrations/providers/resend/body-fetch'
import type { ResendEmailReceived } from '../../../../../lib/integrations/providers/resend/schemas'

function buildMetadata(overrides: Partial<ResendEmailReceived['data']> = {}): ResendEmailReceived {
	return {
		type: 'email.received',
		data: {
			email_id: 'em_test_123',
			from: 'sender@example.com',
			to: ['recipient@example.com'],
			subject: 'Test',
			...overrides,
		},
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

describe('fetchResendBodyWithRetry', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn())
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	it('merges the fetched body into the metadata on a 200', async () => {
		const metadata = buildMetadata()
		vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			jsonResponse(200, { text: 'hi', html: '<p>hi</p>' }),
		)

		const enriched = await fetchResendBodyWithRetry('re_test_key', 'em_test_123', metadata)

		expect(enriched.data.text).toBe('hi')
		expect(enriched.data.html).toBe('<p>hi</p>')
		expect(enriched.data.email_id).toBe('em_test_123')
		expect(enriched.data.subject).toBe('Test')
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it('retries on 429 and succeeds when the third attempt is 200', async () => {
		const metadata = buildMetadata()
		const mock = vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>)
		mock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
		mock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
		mock.mockResolvedValueOnce(jsonResponse(200, { text: 'ok after retry' }))

		const enriched = await fetchResendBodyWithRetry('re_test_key', 'em_test_123', metadata)

		expect(enriched.data.text).toBe('ok after retry')
		expect(mock).toHaveBeenCalledTimes(3)
	})

	it('throws after MAX_ATTEMPTS of 429s', async () => {
		const metadata = buildMetadata()
		const mock = vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>)
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			mock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
		}

		await expect(fetchResendBodyWithRetry('re_test_key', 'em_test_123', metadata)).rejects.toThrow()
		expect(mock).toHaveBeenCalledTimes(MAX_ATTEMPTS)
	})

	it('throws BodyFetchTerminalError on 404 without retrying', async () => {
		const metadata = buildMetadata()
		const mock = vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>)
		mock.mockResolvedValueOnce(new Response('not found', { status: 404 }))

		await expect(
			fetchResendBodyWithRetry('re_test_key', 'em_test_123', metadata),
		).rejects.toBeInstanceOf(BodyFetchTerminalError)
		expect(mock).toHaveBeenCalledTimes(1)
	})

	it('throws after MAX_ATTEMPTS when every attempt times out (abort)', async () => {
		const metadata = buildMetadata()
		const mock = vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>)
		mock.mockImplementation((_input, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal
				const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
				if (signal?.aborted) abort()
				else signal?.addEventListener?.('abort', abort)
			})
		})

		await expect(fetchResendBodyWithRetry('re_test_key', 'em_test_123', metadata)).rejects.toThrow()
		expect(mock).toHaveBeenCalledTimes(MAX_ATTEMPTS)
	}, 15_000)

	it('returns an enriched payload with empty body when the 200 carries empty text/html (route decides)', async () => {
		const metadata = buildMetadata()
		const mock = vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>)
		mock.mockResolvedValueOnce(jsonResponse(200, { text: '', html: '' }))

		const enriched = await fetchResendBodyWithRetry('re_test_key', 'em_test_123', metadata)

		expect(enriched.data.text).toBe('')
		expect(enriched.data.html).toBe('')
		expect(mock).toHaveBeenCalledTimes(1)
	})
})
