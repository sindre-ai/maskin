import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_AUTH_CACHE_TTL_MS,
	TtlPromiseCache,
	createAuthCaches,
	evictActor,
	evictApiKey,
	evictMembership,
	resolveAuthCacheTtlMs,
} from '../auth-cache'

const present = (v: unknown) => v !== null

describe('TtlPromiseCache', () => {
	it('serves a settled value from cache until it expires', async () => {
		const cache = new TtlPromiseCache<string | null>(1_000)
		const load = vi.fn(async () => 'actor')

		await cache.get('k', load, present, 0)
		await cache.get('k', load, present, 999)
		expect(load).toHaveBeenCalledTimes(1)

		await cache.get('k', load, present, 1_000)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('shares one in-flight lookup between concurrent callers', async () => {
		const cache = new TtlPromiseCache<string | null>(1_000)
		let resolve: (v: string) => void = () => {}
		const load = vi.fn(
			() =>
				new Promise<string>((r) => {
					resolve = r
				}),
		)

		const calls = [cache.get('k', load, present), cache.get('k', load, present)]
		resolve('actor')

		expect(await Promise.all(calls)).toEqual(['actor', 'actor'])
		expect(load).toHaveBeenCalledTimes(1)
	})

	it('does not cache a result the caller says is not cacheable', async () => {
		const cache = new TtlPromiseCache<string | null>(1_000)
		const load = vi.fn(async () => null)

		await cache.get('k', load, present, 0)
		await Promise.resolve() // let the settle handler run
		await cache.get('k', load, present, 1)

		expect(load).toHaveBeenCalledTimes(2)
	})

	it('does not cache a failed lookup', async () => {
		const cache = new TtlPromiseCache<string | null>(1_000)
		const load = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue('actor')

		await expect(cache.get('k', load, present, 0)).rejects.toThrow('db down')
		await Promise.resolve()
		await expect(cache.get('k', load, present, 1)).resolves.toBe('actor')
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('never caches when the ttl is 0', async () => {
		const cache = new TtlPromiseCache<string | null>(0)
		const load = vi.fn(async () => 'actor')

		await cache.get('k', load, present)
		await cache.get('k', load, present)

		expect(load).toHaveBeenCalledTimes(2)
	})

	it('stays within its size cap', async () => {
		const cache = new TtlPromiseCache<string | null>(60_000, 3)
		const load = vi.fn(async () => 'actor')

		for (const key of ['a', 'b', 'c', 'd', 'e']) await cache.get(key, load, present, 0)
		load.mockClear()

		await cache.get('a', load, present, 1) // oldest entries were evicted
		expect(load).toHaveBeenCalledTimes(1)
	})
})

describe('eviction', () => {
	async function warmedCaches() {
		const caches = createAuthCaches(60_000)
		const keyLoad = vi.fn(async () => ({ actorId: 'actor-1', type: 'human' }))
		const memberLoad = vi.fn(async () => true)
		await caches.apiKeys.get('ank_1', keyLoad, present)
		await caches.memberships.get('actor-1|ws-1', memberLoad, (v) => v)
		keyLoad.mockClear()
		memberLoad.mockClear()
		return { caches, keyLoad, memberLoad }
	}

	it('evictApiKey drops that key so the next request asks the database', async () => {
		const { caches, keyLoad } = await warmedCaches()

		evictApiKey('ank_1')
		await caches.apiKeys.get('ank_1', keyLoad, present)

		expect(keyLoad).toHaveBeenCalledTimes(1)
	})

	it('evictMembership drops only that actor/workspace pair', async () => {
		const { caches, memberLoad } = await warmedCaches()
		await caches.memberships.get('actor-1|ws-2', memberLoad, (v) => v)
		memberLoad.mockClear()

		evictMembership('actor-1', 'ws-1')
		await caches.memberships.get('actor-1|ws-1', memberLoad, (v) => v)
		await caches.memberships.get('actor-1|ws-2', memberLoad, (v) => v)

		expect(memberLoad).toHaveBeenCalledTimes(1)
	})

	it('evictActor drops the actor memberships and every cached key lookup', async () => {
		const { caches, keyLoad, memberLoad } = await warmedCaches()

		evictActor('actor-1')
		await caches.apiKeys.get('ank_1', keyLoad, present)
		await caches.memberships.get('actor-1|ws-1', memberLoad, (v) => v)

		expect(keyLoad).toHaveBeenCalledTimes(1)
		expect(memberLoad).toHaveBeenCalledTimes(1)
	})
})

describe('resolveAuthCacheTtlMs', () => {
	it('defaults when unset or blank', () => {
		expect(resolveAuthCacheTtlMs(undefined)).toBe(DEFAULT_AUTH_CACHE_TTL_MS)
		expect(resolveAuthCacheTtlMs('  ')).toBe(DEFAULT_AUTH_CACHE_TTL_MS)
	})

	it('accepts 0 to disable and positive values', () => {
		expect(resolveAuthCacheTtlMs('0')).toBe(0)
		expect(resolveAuthCacheTtlMs('2500')).toBe(2500)
	})

	it('falls back to the default for garbage and negatives', () => {
		expect(resolveAuthCacheTtlMs('soon')).toBe(DEFAULT_AUTH_CACHE_TTL_MS)
		expect(resolveAuthCacheTtlMs('-5')).toBe(DEFAULT_AUTH_CACHE_TTL_MS)
	})
})
