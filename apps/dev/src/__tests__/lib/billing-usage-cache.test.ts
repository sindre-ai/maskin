import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BILLING_USAGE_CACHE_TTL_MS,
	_resetBillingUsageCache,
	cachedBillingUsage,
	evictBillingUsage,
} from '../../lib/billing-usage-cache'

beforeEach(() => {
	_resetBillingUsageCache()
})

describe('cachedBillingUsage', () => {
	it('serves a repeat read inside the TTL without recomputing', async () => {
		const compute = vi.fn().mockResolvedValue({ usd_cents_used: 5 })

		const first = await cachedBillingUsage('actor-a', 'ws-1', compute, 1_000)
		const second = await cachedBillingUsage('actor-a', 'ws-1', compute, 1_000 + 1_999)

		expect(compute).toHaveBeenCalledTimes(1)
		expect(second).toBe(first)
	})

	it('recomputes once the TTL has passed', async () => {
		const compute = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new')

		await cachedBillingUsage('actor-a', 'ws-1', compute, 1_000)
		const after = await cachedBillingUsage(
			'actor-a',
			'ws-1',
			compute,
			1_000 + BILLING_USAGE_CACHE_TTL_MS,
		)

		expect(compute).toHaveBeenCalledTimes(2)
		expect(after).toBe('new')
	})

	it('does not share an entry between actors in the same workspace', async () => {
		const computeA = vi.fn().mockResolvedValue('for-a')
		const computeB = vi.fn().mockResolvedValue('for-b')

		const a = await cachedBillingUsage('actor-a', 'ws-1', computeA, 1_000)
		const b = await cachedBillingUsage('actor-b', 'ws-1', computeB, 1_000)

		expect(a).toBe('for-a')
		expect(b).toBe('for-b')
		expect(computeB).toHaveBeenCalledTimes(1)
	})

	it('does not share an entry between workspaces for the same actor', async () => {
		const compute1 = vi.fn().mockResolvedValue('ws-1-data')
		const compute2 = vi.fn().mockResolvedValue('ws-2-data')

		const one = await cachedBillingUsage('actor-a', 'ws-1', compute1, 1_000)
		const two = await cachedBillingUsage('actor-a', 'ws-2', compute2, 1_000)

		expect(one).toBe('ws-1-data')
		expect(two).toBe('ws-2-data')
		expect(compute2).toHaveBeenCalledTimes(1)
	})

	it('shares one in-flight computation between concurrent callers', async () => {
		let resolve: (v: string) => void = () => {}
		const compute = vi.fn(
			() =>
				new Promise<string>((r) => {
					resolve = r
				}),
		)

		const p1 = cachedBillingUsage('actor-a', 'ws-1', compute, 1_000)
		const p2 = cachedBillingUsage('actor-a', 'ws-1', compute, 1_000)
		resolve('shared')

		expect(await p1).toBe('shared')
		expect(await p2).toBe('shared')
		expect(compute).toHaveBeenCalledTimes(1)
	})

	it('does not keep a failed read for the rest of the window', async () => {
		const compute = vi
			.fn()
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValueOnce('recovered')

		await expect(cachedBillingUsage('actor-a', 'ws-1', compute, 1_000)).rejects.toThrow('db down')
		const retry = await cachedBillingUsage('actor-a', 'ws-1', compute, 1_100)

		expect(retry).toBe('recovered')
		expect(compute).toHaveBeenCalledTimes(2)
	})

	it('evicts every actor for one workspace and leaves other workspaces alone', async () => {
		const compute = vi.fn().mockResolvedValue('v')
		await cachedBillingUsage('actor-a', 'ws-1', compute, 1_000)
		await cachedBillingUsage('actor-b', 'ws-1', compute, 1_000)
		await cachedBillingUsage('actor-a', 'ws-2', compute, 1_000)
		expect(compute).toHaveBeenCalledTimes(3)

		evictBillingUsage('ws-1')

		await cachedBillingUsage('actor-a', 'ws-1', compute, 1_100)
		await cachedBillingUsage('actor-b', 'ws-1', compute, 1_100)
		await cachedBillingUsage('actor-a', 'ws-2', compute, 1_100)
		// Both ws-1 entries recomputed; the ws-2 entry was still cached.
		expect(compute).toHaveBeenCalledTimes(5)
	})
})
