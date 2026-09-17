import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { logger } from '../../lib/logger'
import { getModelPricing, refreshPricing, resetPricingCache } from '../../lib/openrouter-pricing'

/** A catalogue shaped like OpenRouter's `GET /api/v1/models` response. */
const CATALOGUE = {
	data: [
		{
			id: 'deepseek/deepseek-v4-flash',
			pricing: {
				prompt: '0.00000007',
				completion: '0.00000014',
				input_cache_read: '0.000000014',
			},
		},
		{
			id: 'legacy/model',
			pricing: {
				prompt: '0.000001',
				completion: '0.000002',
				cache_read: '0.0000001',
				cache_write: '0.00000125',
			},
		},
		// No published prompt price — must read as unknown, not as free.
		{ id: 'broken/model', pricing: { completion: '0.000002' } },
	],
}

const okResponse = (body: unknown): Response =>
	({ ok: true, status: 200, json: async () => body }) as unknown as Response

describe('openrouter-pricing', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let nowSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		resetPricingCache()
		vi.clearAllMocks()
		fetchMock = vi.fn(async () => okResponse(CATALOGUE))
		vi.stubGlobal('fetch', fetchMock)
		nowSpy = vi.spyOn(Date, 'now')
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		nowSpy.mockRestore()
	})

	it('parses the published per-token prices for a model', async () => {
		const pricing = await getModelPricing('deepseek/deepseek-v4-flash')
		expect(pricing).toEqual({
			prompt: 0.00000007,
			completion: 0.00000014,
			cacheRead: 0.000000014,
			cacheWrite: 0,
		})
	})

	it('reads cache prices under both the current and legacy catalogue keys', async () => {
		const pricing = await getModelPricing('legacy/model')
		expect(pricing?.cacheRead).toBe(0.0000001)
		expect(pricing?.cacheWrite).toBe(0.00000125)
	})

	it('returns null and logs for a model absent from the catalogue', async () => {
		expect(await getModelPricing('absent/model')).toBeNull()
		expect(logger.warn).toHaveBeenCalledWith('pricing_unknown_model', { model: 'absent/model' })
	})

	it('treats a model missing its prompt price as unknown rather than free', async () => {
		expect(await getModelPricing('broken/model')).toBeNull()
	})

	it('serves the cached catalogue without re-fetching within the TTL', async () => {
		nowSpy.mockReturnValue(1_000)
		await getModelPricing('deepseek/deepseek-v4-flash')
		nowSpy.mockReturnValue(1_000 + 59 * 60 * 1000)
		await getModelPricing('deepseek/deepseek-v4-flash')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('serves stale prices and refreshes in the background once past the TTL', async () => {
		nowSpy.mockReturnValue(1_000)
		await getModelPricing('deepseek/deepseek-v4-flash')
		expect(fetchMock).toHaveBeenCalledTimes(1)

		// The refresh returns a changed price; the current call must still see
		// the stale one (never block a session lifecycle on a network round trip).
		fetchMock.mockResolvedValue(
			okResponse({
				data: [
					{
						id: 'deepseek/deepseek-v4-flash',
						pricing: { prompt: '0.0000005', completion: '0.0000009' },
					},
				],
			}),
		)
		nowSpy.mockReturnValue(1_000 + 61 * 60 * 1000)
		const pricing = await getModelPricing('deepseek/deepseek-v4-flash')
		expect(pricing?.prompt).toBe(0.00000007)

		// Wait for the background refresh to actually land, not merely for the
		// fetch to be issued — the cache flips a microtask after the call.
		await vi.waitFor(async () => {
			const refreshed = await getModelPricing('deepseek/deepseek-v4-flash')
			expect(refreshed?.prompt).toBe(0.0000005)
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('logs and returns null when the catalogue is unreachable on a cold cache', async () => {
		fetchMock.mockRejectedValue(new Error('network down'))
		expect(await getModelPricing('deepseek/deepseek-v4-flash')).toBeNull()
		expect(logger.error).toHaveBeenCalledWith('pricing_malformed', {
			reason: 'fetch_failed',
			error: 'Error: network down',
		})
		expect(logger.error).toHaveBeenCalledWith('pricing_cold_fallback', {
			model: 'deepseek/deepseek-v4-flash',
		})
	})

	it('logs and returns null on a non-OK catalogue response', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 503 } as unknown as Response)
		expect(await getModelPricing('deepseek/deepseek-v4-flash')).toBeNull()
		expect(logger.error).toHaveBeenCalledWith('pricing_malformed', {
			status: 503,
			reason: 'non_ok_response',
		})
	})

	it('logs and returns null when the payload has an unexpected shape', async () => {
		fetchMock.mockResolvedValue(okResponse({ models: [] }))
		expect(await getModelPricing('deepseek/deepseek-v4-flash')).toBeNull()
		expect(logger.error).toHaveBeenCalledWith('pricing_malformed', {
			reason: 'unexpected_payload_shape',
		})
	})

	it('dedupes concurrent cold-cache lookups into a single fetch', async () => {
		const [a, b] = await Promise.all([
			getModelPricing('deepseek/deepseek-v4-flash'),
			getModelPricing('deepseek/deepseek-v4-flash'),
		])
		expect(a).toEqual(b)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('exposes refreshPricing for tests to prime the cache directly', async () => {
		const models = await refreshPricing()
		expect(models?.get('deepseek/deepseek-v4-flash')?.prompt).toBe(0.00000007)
	})
})
