import { describe, expect, it, vi } from 'vitest'
import { createAuthCaches, evictOAuthTokens } from '../auth-cache'

const present = (v: unknown) => v !== null

describe('oauthTokens cache', () => {
	it('caches positive results only', async () => {
		const caches = createAuthCaches(1_000)
		const hit = vi.fn(async () => ({ grantId: 'g' }) as never)
		await caches.oauthTokens.get('hash-a', hit, present, 0)
		await caches.oauthTokens.get('hash-a', hit, present, 1)
		expect(hit).toHaveBeenCalledTimes(1)

		const miss = vi.fn(async () => null)
		await caches.oauthTokens.get('hash-b', miss, present, 0)
		await caches.oauthTokens.get('hash-b', miss, present, 1)
		expect(miss).toHaveBeenCalledTimes(2)
	})

	it('evictOAuthTokens clears every instance so a revoked token stops resolving at once', async () => {
		const first = createAuthCaches(10_000)
		const second = createAuthCaches(10_000)
		const load = vi.fn(async () => ({ grantId: 'g' }) as never)
		await first.oauthTokens.get('hash', load, present, 0)
		await second.oauthTokens.get('hash', load, present, 0)
		expect(load).toHaveBeenCalledTimes(2)

		evictOAuthTokens()

		await first.oauthTokens.get('hash', load, present, 1)
		await second.oauthTokens.get('hash', load, present, 1)
		expect(load).toHaveBeenCalledTimes(4)
	})

	it('evictOAuthTokens leaves the API key and membership caches alone', async () => {
		const caches = createAuthCaches(10_000)
		const load = vi.fn(async () => 'member' as string | null)
		await caches.memberships.get('a|w', load, present, 0)
		evictOAuthTokens()
		await caches.memberships.get('a|w', load, present, 1)
		expect(load).toHaveBeenCalledTimes(1)
	})
})
