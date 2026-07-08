import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock crypto module (identity functions)
vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn((input: string) => input),
	encrypt: vi.fn((input: string) => input),
}))

// Mock logger
vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}))

import {
	type ClaudeOAuthTokens,
	type EncryptedOAuthData,
	decryptOAuthData,
	encryptOAuthTokens,
	getValidOAuthToken,
	persistRefreshedSlot,
	refreshClaudeToken,
	refreshClaudeTokenIfNeeded,
} from '../../lib/claude-oauth'
import { decrypt, encrypt } from '../../lib/crypto'

/**
 * Mock DB whose select chain supports both the unlocked outer read
 * (`select().from().where().limit()`) and the locked re-read inside the
 * persist transaction (`select().from().where().for('update').limit()`).
 * `transaction(fn)` invokes the callback with the same mock db so writes
 * inside the tx call through the same captured spies.
 */
function createMockDb(workspace?: Record<string, unknown>) {
	const limitResult = workspace ? [workspace] : []
	const mockLimit = vi.fn().mockResolvedValue(limitResult)
	const mockFor = vi.fn().mockReturnValue({ limit: mockLimit })
	const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit, for: mockFor })
	const mockUpdateWhere = vi.fn().mockResolvedValue(undefined)
	const mockTransaction = vi.fn()

	const db = {
		select: vi.fn().mockReturnValue({
			from: vi.fn().mockReturnValue({ where: mockWhere }),
		}),
		update: vi.fn().mockReturnValue({
			set: vi.fn().mockReturnValue({ where: mockUpdateWhere }),
		}),
		transaction: mockTransaction,
	}
	mockTransaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db))

	return {
		db: db as unknown as Parameters<typeof getValidOAuthToken>[0],
		mockUpdateWhere,
		mockTransaction,
		mockFor,
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
})

function makeTokens(overrides?: Partial<ClaudeOAuthTokens>): ClaudeOAuthTokens {
	return {
		accessToken: 'access-123',
		refreshToken: 'refresh-456',
		expiresAt: Date.now() + 60 * 60 * 1000,
		scopes: ['read'],
		...overrides,
	}
}

describe('refreshClaudeToken', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.mocked(decrypt).mockImplementation((input: string) => input)
		vi.mocked(encrypt).mockImplementation((input: string) => input)
	})

	it('sends correct body with grant_type, client_id, and refresh_token', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					access_token: 'new-access',
					expires_in: 3600,
				}),
		})
		vi.stubGlobal('fetch', mockFetch)

		const tokens = makeTokens()
		await refreshClaudeToken(tokens)

		const [, options] = mockFetch.mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.grant_type).toBe('refresh_token')
		expect(body.client_id).toBeDefined()
		expect(body.refresh_token).toBe('refresh-456')
	})

	it('returns updated tokens from response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: 'new-access',
						refresh_token: 'new-refresh',
						expires_in: 7200,
						scope: 'read write',
						subscription_type: 'pro',
					}),
			}),
		)

		const tokens = makeTokens({ subscriptionType: 'free' })
		const result = await refreshClaudeToken(tokens)

		expect(result.accessToken).toBe('new-access')
		expect(result.refreshToken).toBe('new-refresh')
		expect(result.subscriptionType).toBe('free') // preserves original
		expect(result.scopes).toEqual(['read', 'write'])
	})

	it('preserves original refresh_token when response omits it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: 'new-access',
						expires_in: 3600,
					}),
			}),
		)

		const tokens = makeTokens({ refreshToken: 'original-refresh' })
		const result = await refreshClaudeToken(tokens)

		expect(result.refreshToken).toBe('original-refresh')
	})

	it('parses scope string into array', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: 'new-access',
						expires_in: 3600,
						scope: 'read write admin',
					}),
			}),
		)

		const tokens = makeTokens()
		const result = await refreshClaudeToken(tokens)

		expect(result.scopes).toEqual(['read', 'write', 'admin'])
	})

	it('throws on non-ok response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: () => Promise.resolve('Unauthorized'),
			}),
		)

		const tokens = makeTokens()
		await expect(refreshClaudeToken(tokens)).rejects.toThrow('Token refresh failed (401)')
	})
})

describe('refreshClaudeTokenIfNeeded', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.mocked(decrypt).mockImplementation((input: string) => input)
		vi.mocked(encrypt).mockImplementation((input: string) => input)
	})

	it('returns original tokens when not expired (refreshed=false)', async () => {
		const tokens = makeTokens({ expiresAt: Date.now() + 60 * 60 * 1000 })
		const result = await refreshClaudeTokenIfNeeded(tokens)

		expect(result.refreshed).toBe(false)
		expect(result.tokens).toBe(tokens)
	})

	it('refreshes when within buffer (refreshed=true)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: 'refreshed-access',
						expires_in: 3600,
					}),
			}),
		)

		// Expires in 5 minutes, within default 10-minute buffer
		const tokens = makeTokens({ expiresAt: Date.now() + 5 * 60 * 1000 })
		const result = await refreshClaudeTokenIfNeeded(tokens)

		expect(result.refreshed).toBe(true)
		expect(result.tokens.accessToken).toBe('refreshed-access')
	})

	it('uses custom bufferMs', async () => {
		// Expires in 5 minutes, but custom buffer is only 1 minute -> no refresh needed
		const tokens = makeTokens({ expiresAt: Date.now() + 5 * 60 * 1000 })
		const result = await refreshClaudeTokenIfNeeded(tokens, 60 * 1000)

		expect(result.refreshed).toBe(false)
		expect(result.tokens).toBe(tokens)
	})
})

describe('decryptOAuthData', () => {
	beforeEach(() => {
		vi.mocked(decrypt).mockImplementation((input: string) => input)
	})

	it('calls decrypt on access and refresh tokens', () => {
		const data: EncryptedOAuthData = {
			encryptedAccessToken: 'enc-access',
			encryptedRefreshToken: 'enc-refresh',
			expiresAt: 12345,
			subscriptionType: 'pro',
			scopes: ['read'],
		}

		const result = decryptOAuthData(data)

		expect(decrypt).toHaveBeenCalledWith('enc-access')
		expect(decrypt).toHaveBeenCalledWith('enc-refresh')
		expect(result.accessToken).toBe('enc-access') // identity fn
		expect(result.refreshToken).toBe('enc-refresh')
		expect(result.expiresAt).toBe(12345)
		expect(result.subscriptionType).toBe('pro')
		expect(result.scopes).toEqual(['read'])
	})
})

describe('encryptOAuthTokens', () => {
	beforeEach(() => {
		vi.mocked(encrypt).mockImplementation((input: string) => input)
	})

	it('calls encrypt on access and refresh tokens', () => {
		const tokens = makeTokens({
			accessToken: 'plain-access',
			refreshToken: 'plain-refresh',
			subscriptionType: 'free',
			scopes: ['write'],
		})

		const result = encryptOAuthTokens(tokens)

		expect(encrypt).toHaveBeenCalledWith('plain-access')
		expect(encrypt).toHaveBeenCalledWith('plain-refresh')
		expect(result.encryptedAccessToken).toBe('plain-access') // identity fn
		expect(result.encryptedRefreshToken).toBe('plain-refresh')
		expect(result.expiresAt).toBe(tokens.expiresAt)
		expect(result.subscriptionType).toBe('free')
		expect(result.scopes).toEqual(['write'])
	})
})

describe('getValidOAuthToken', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.mocked(decrypt).mockImplementation((input: string) => input)
		vi.mocked(encrypt).mockImplementation((input: string) => input)
	})

	it('returns null when no oauth data in workspace settings', async () => {
		const { db } = createMockDb({ id: 'ws-1', settings: {} })

		const result = await getValidOAuthToken(db, 'ws-1')
		expect(result).toBeNull()
	})

	it('returns null when no encrypted tokens', async () => {
		const { db } = createMockDb({
			id: 'ws-1',
			settings: {
				claude_oauth: { expiresAt: 12345 },
			},
		})

		const result = await getValidOAuthToken(db, 'ws-1')
		expect(result).toBeNull()
	})

	it('returns token without DB update when fresh', async () => {
		const oauthData: EncryptedOAuthData = {
			encryptedAccessToken: 'enc-access',
			encryptedRefreshToken: 'enc-refresh',
			expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
			scopes: ['read'],
		}
		const { db, mockUpdateWhere } = createMockDb({
			id: 'ws-1',
			settings: { claude_oauth: oauthData },
		})

		const result = await getValidOAuthToken(db, 'ws-1')

		expect(result).not.toBeNull()
		expect(result?.accessToken).toBe('enc-access') // identity decrypt
		expect(mockUpdateWhere).not.toHaveBeenCalled()
	})

	it('refreshes and updates DB when expired', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						access_token: 'new-access',
						expires_in: 3600,
					}),
			}),
		)

		const oauthData: EncryptedOAuthData = {
			encryptedAccessToken: 'enc-access',
			encryptedRefreshToken: 'enc-refresh',
			expiresAt: Date.now() - 1000, // expired
			scopes: ['read'],
		}
		const { db, mockUpdateWhere } = createMockDb({
			id: 'ws-1',
			settings: { claude_oauth: oauthData },
		})

		const result = await getValidOAuthToken(db, 'ws-1')

		expect(result).not.toBeNull()
		expect(result?.accessToken).toBe('new-access')
		expect(mockUpdateWhere).toHaveBeenCalled()
	})

	it('locks the workspace row in a transaction before writing the refreshed slot', async () => {
		// AC-T4 guard: every refresh that persists must go through the row-lock
		// transaction in persistRefreshedSlot, otherwise a parallel slot refresh
		// could clobber it.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ access_token: 'new-access', expires_in: 3600 }),
			}),
		)
		const oauthData: EncryptedOAuthData = {
			encryptedAccessToken: 'enc-access',
			encryptedRefreshToken: 'enc-refresh',
			expiresAt: Date.now() - 1000,
		}
		const { db, mockTransaction, mockFor } = createMockDb({
			id: 'ws-1',
			settings: { claude_oauth: oauthData },
		})

		await getValidOAuthToken(db, 'ws-1')

		expect(mockTransaction).toHaveBeenCalledTimes(1)
		expect(mockFor).toHaveBeenCalledWith('update')
	})
})

describe('persistRefreshedSlot', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		vi.mocked(decrypt).mockImplementation((input: string) => input)
		vi.mocked(encrypt).mockImplementation((input: string) => input)
	})

	const fresh: EncryptedOAuthData = {
		encryptedAccessToken: 'fresh-enc',
		encryptedRefreshToken: 'fresh-enc-rt',
		expiresAt: 9_999_999_999_999,
		subscriptionType: 'pro',
	}

	it('merges new-shape settings preserving the other slot and failover state', async () => {
		const otherSlot: EncryptedOAuthData = {
			encryptedAccessToken: 'backup-enc',
			encryptedRefreshToken: 'backup-enc-rt',
			expiresAt: 1_000,
		}
		const { db, mockUpdateWhere, mockTransaction, mockFor } = createMockDb({
			id: 'ws-1',
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: {
						encryptedAccessToken: 'p-old',
						encryptedRefreshToken: 'p-old-rt',
						expiresAt: 1,
					},
					backup: otherSlot,
					failover: { active_slot: 'primary' },
				},
			},
		})

		await persistRefreshedSlot(db, 'ws-1', 'primary', fresh)

		expect(mockTransaction).toHaveBeenCalledTimes(1)
		expect(mockFor).toHaveBeenCalledWith('update')
		expect(mockUpdateWhere).toHaveBeenCalledTimes(1)
		// The set() captured object holds the merged settings — pull it back via
		// the update().set chain.
		const setCall = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0]
		expect(setCall.settings.claude_oauth).toEqual({
			primary: fresh,
			backup: otherSlot,
			failover: { active_slot: 'primary' },
		})
		// Outer settings keys are preserved too.
		expect(setCall.settings.enabled_modules).toEqual(['work'])
	})

	it('upgrades a legacy single-slot row to the new shape under `primary`', async () => {
		const legacy: EncryptedOAuthData = {
			encryptedAccessToken: 'legacy-enc',
			encryptedRefreshToken: 'legacy-enc-rt',
			expiresAt: 12345,
		}
		const { db } = createMockDb({
			id: 'ws-1',
			settings: { enabled_modules: ['work'], claude_oauth: legacy },
		})

		await persistRefreshedSlot(db, 'ws-1', 'primary', fresh)

		const setCall = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0]
		expect(setCall.settings.claude_oauth).toEqual({ primary: fresh })
	})

	it('no-ops when the workspace row has disappeared between read and lock', async () => {
		const { db, mockUpdateWhere } = createMockDb(undefined)
		await persistRefreshedSlot(db, 'ws-gone', 'primary', fresh)
		expect(mockUpdateWhere).not.toHaveBeenCalled()
	})
})
