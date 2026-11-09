import { createTtlCache } from '../../lib/ttl-cache'

describe('createTtlCache', () => {
	it('runs the load once for callers that arrive while it is loading', async () => {
		const cache = createTtlCache<number>({ ttlMs: 1_000 })
		let release: (n: number) => void = () => {}
		const load = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					release = resolve
				}),
		)
		const calls = [cache.get('k', load), cache.get('k', load), cache.get('k', load)]
		release(7)
		expect(await Promise.all(calls)).toEqual([7, 7, 7])
		expect(load).toHaveBeenCalledTimes(1)
	})

	it('serves the kept result until the ttl has passed, then loads again', async () => {
		const cache = createTtlCache<number>({ ttlMs: 1_000 })
		const load = vi.fn(async () => 1)
		await cache.get('k', load)
		await cache.get('k', load, Date.now() + 500)
		expect(load).toHaveBeenCalledTimes(1)
		await cache.get('k', load, Date.now() + 2_000)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('keeps keys apart', async () => {
		const cache = createTtlCache<string>({ ttlMs: 1_000 })
		expect(await cache.get('a', async () => 'A')).toBe('A')
		expect(await cache.get('b', async () => 'B')).toBe('B')
	})

	it('does not keep a failed load, so the next caller retries', async () => {
		const cache = createTtlCache<number>({ ttlMs: 1_000 })
		await expect(
			cache.get('k', async () => {
				throw new Error('db down')
			}),
		).rejects.toThrow('db down')
		expect(await cache.get('k', async () => 5)).toBe(5)
	})

	it('invalidate drops a key so the next call loads again', async () => {
		const cache = createTtlCache<number>({ ttlMs: 60_000 })
		const load = vi.fn(async () => 1)
		await cache.get('k', load)
		cache.invalidate('k')
		await cache.get('k', load)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('stays under maxEntries', async () => {
		const cache = createTtlCache<number>({ ttlMs: 60_000, maxEntries: 10 })
		for (let i = 0; i < 50; i++) await cache.get(`k${i}`, async () => i)
		const load = vi.fn(async () => -1)
		await cache.get('k0', load) // long dropped, loads again
		expect(load).toHaveBeenCalledTimes(1)
	})
})
