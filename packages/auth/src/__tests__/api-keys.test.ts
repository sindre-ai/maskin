import type { Database } from '@maskin/db'
import { describe, expect, it, vi } from 'vitest'
import {
	LOGIN_KEY_CAP,
	generateApiKey,
	issueApiKey,
	issueLoginKey,
	revokeActorKeys,
	revokeSessionKeys,
	validateApiKey,
} from '../api-keys'
import { createAuthCaches } from '../auth-cache'
import { hashApiKey } from '../key-hash'
import { createMockDb } from './helpers'

describe('generateApiKey', () => {
	it('returns an object with a key property', () => {
		const result = generateApiKey()
		expect(result).toHaveProperty('key')
	})

	it('generates a key with ank_ prefix', () => {
		const { key } = generateApiKey()
		expect(key.startsWith('ank_')).toBe(true)
	})

	it('generates a key of correct length', () => {
		const { key } = generateApiKey()
		// ank_ (4) + UUID without hyphens (32) = 36
		expect(key).toHaveLength(36)
	})

	it('generates only alphanumeric characters after prefix', () => {
		const { key } = generateApiKey()
		const suffix = key.slice(4)
		expect(suffix).toMatch(/^[a-f0-9]+$/)
	})

	it('generates unique keys on each call', () => {
		const keys = new Set(Array.from({ length: 10 }, () => generateApiKey().key))
		expect(keys.size).toBe(10)
	})
})

describe('validateApiKey', () => {
	it('returns actorId and type when actor is found', async () => {
		const db = createMockDb([[{ id: 'actor-123', type: 'human', keyId: 'key-1' }]])
		const result = await validateApiKey(db, 'ank_testkey')
		expect(result).toEqual({ actorId: 'actor-123', type: 'human' })
	})

	it('stamps last_used_at on the key row that matched', async () => {
		const { db, updates } = createWriteDb({
			selectRows: [{ id: 'actor-123', type: 'human', keyId: 'key-1' }],
		})
		await validateApiKey(db, 'ank_testkey')
		expect(updates).toHaveLength(1)
		expect(updates[0].lastUsedAt).toBeInstanceOf(Date)
	})

	it('does not stamp when no key matches', async () => {
		const { db, updates } = createWriteDb({ selectRows: [] })
		expect(await validateApiKey(db, 'ank_nope')).toBeNull()
		expect(updates).toHaveLength(0)
	})

	it('still authenticates when the stamp fails', async () => {
		const { db } = createWriteDb({
			selectRows: [{ id: 'actor-123', type: 'human', keyId: 'key-1' }],
			failUpdate: true,
		})
		expect(await validateApiKey(db, 'ank_testkey')).toEqual({
			actorId: 'actor-123',
			type: 'human',
		})
	})

	it('returns null when no actor matches', async () => {
		const db = createMockDb([[]])
		const result = await validateApiKey(db, 'ank_invalidkey')
		expect(result).toBeNull()
	})

	it('returns null for undefined result', async () => {
		const db = createMockDb([[undefined]])
		const result = await validateApiKey(db, 'ank_missing')
		expect(result).toBeNull()
	})
})

describe('hashApiKey', () => {
	it('is the hex SHA-256 of the key', () => {
		expect(hashApiKey('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
	})

	it('is deterministic and 64 hex characters', () => {
		const { key } = generateApiKey()
		expect(hashApiKey(key)).toBe(hashApiKey(key))
		expect(hashApiKey(key)).toMatch(/^[a-f0-9]{64}$/)
	})
})

/** A db double that records inserts and updates and answers each query chain with canned rows. */
function createWriteDb(
	opts: { updateRows?: unknown[]; selectRows?: unknown[]; failUpdate?: boolean } = {},
) {
	const inserted: Record<string, unknown>[] = []
	const updates: Record<string, unknown>[] = []
	const selectChain: Record<string, unknown> = {}
	for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'offset', 'limit'])
		selectChain[m] = () => selectChain
	// biome-ignore lint/suspicious/noThenProperty: the mock must be awaitable like a Drizzle query
	selectChain.then = (resolve: (v: unknown) => void) => resolve(opts.selectRows ?? [])
	const db = {
		insert: () => ({
			values: async (v: Record<string, unknown>) => {
				inserted.push(v)
			},
		}),
		update: () => ({
			set: (patch: Record<string, unknown>) => {
				if (opts.failUpdate) throw new Error('write failed')
				updates.push(patch)
				return {
					where: () => ({
						returning: async () => opts.updateRows ?? [],
						// biome-ignore lint/suspicious/noThenProperty: awaitable without returning()
						then: (resolve: (v: unknown) => void) => resolve(undefined),
					}),
				}
			},
		}),
		select: () => selectChain,
	} as unknown as Database
	return { db, inserted, updates }
}

describe('issueApiKey', () => {
	it('stores only the hash and last four characters, and returns the plaintext once', async () => {
		const { db, inserted } = createWriteDb()

		const { key, keyHash } = await issueApiKey(db, {
			actorId: 'actor-1',
			kind: 'session',
			sessionId: 'session-1',
		})

		expect(key.startsWith('ank_')).toBe(true)
		expect(keyHash).toBe(hashApiKey(key))
		expect(inserted).toHaveLength(1)
		expect(inserted[0]).toMatchObject({
			actorId: 'actor-1',
			keyHash,
			last4: key.slice(-4),
			kind: 'session',
			sessionId: 'session-1',
			expiresAt: null,
		})
		expect(JSON.stringify(inserted[0])).not.toContain(key)
	})
})

describe('revoking keys', () => {
	it('drops each revoked key from the auth cache so it stops working at once', async () => {
		const caches = createAuthCaches(60_000)
		const hash = hashApiKey('ank_revoked')
		const load = vi.fn(async () => ({ actorId: 'actor-1', type: 'agent' }))
		await caches.apiKeys.get(hash, load, (v) => v !== null)
		load.mockClear()
		const { db } = createWriteDb({ updateRows: [{ keyHash: hash }] })

		const revoked = await revokeSessionKeys(db, 'session-1')
		await caches.apiKeys.get(hash, load, (v) => v !== null)

		expect(revoked).toEqual([hash])
		expect(load).toHaveBeenCalledTimes(1)
	})

	it('revokeActorKeys returns the hashes it revoked', async () => {
		const { db, updates } = createWriteDb({ updateRows: [{ keyHash: 'h1' }, { keyHash: 'h2' }] })

		expect(await revokeActorKeys(db, 'actor-1', ['primary', 'login'])).toEqual(['h1', 'h2'])
		expect(updates[0]).toHaveProperty('revokedAt')
	})
})

describe('issueLoginKey', () => {
	it('keeps every key while the actor is under the cap', async () => {
		const { db, inserted, updates } = createWriteDb({ selectRows: [] })

		const key = await issueLoginKey(db, 'actor-1', 'login')

		expect(key.startsWith('ank_')).toBe(true)
		expect(inserted[0]).toMatchObject({ actorId: 'actor-1', kind: 'login' })
		expect(updates).toHaveLength(0)
	})

	it('revokes the keys past the cap, oldest first', async () => {
		const { db, updates } = createWriteDb({
			selectRows: [{ id: 'old-1', keyHash: 'old-hash-1' }],
		})

		await issueLoginKey(db, 'actor-1', 'login_ios')

		expect(LOGIN_KEY_CAP).toBe(10)
		expect(updates).toHaveLength(1)
		expect(updates[0]).toHaveProperty('revokedAt')
	})
})
