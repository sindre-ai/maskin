import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRY_DELAYS_MS, runGitHubPreflight } from '../../../lib/github/preflight'

const identity = {
	name: 'github-sindre-ai',
	token: 'ghs_real',
	writeProbeRepo: 'sindre-ai/maskin',
}

describe('runGitHubPreflight default retry window', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('keeps retrying through a GitHub 5xx burst of about 10s and stays healthy', async () => {
		const fetchImpl = vi.fn(async () => new Response('', { status: 500 }))
		fetchImpl
			.mockResolvedValueOnce(new Response('', { status: 500 }))
			.mockResolvedValueOnce(new Response('', { status: 500 }))
			.mockResolvedValueOnce(new Response('', { status: 500 }))
			.mockResolvedValueOnce(new Response('', { status: 500 }))
			.mockResolvedValueOnce(new Response('{"sha":"abc"}', { status: 201 }))
		const pending = runGitHubPreflight([identity], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0))
		expect(await pending).toEqual([{ name: 'github-sindre-ai', healthy: true }])
		expect(fetchImpl).toHaveBeenCalledTimes(5)
	})

	it('reports upstream-error only after every attempt in the window failed', async () => {
		const fetchImpl = vi.fn(async () => new Response('', { status: 500 }))
		const pending = runGitHubPreflight([identity], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0))
		const [verdict] = await pending
		expect(verdict?.failureClass).toBe('upstream-error')
		expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_RETRY_DELAYS_MS.length + 1)
	})
})
