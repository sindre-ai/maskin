import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock crypto module (identity functions)
vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn((input: string) => input),
	encrypt: vi.fn((input: string) => input),
}))

// Mock logger
vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}))

import { decrypt, encrypt } from '../../lib/crypto'
import {
	type ClaudeOAuthTokens,
	type EncryptedOAuthData,
	decryptOAuthData,
	encryptOAuthTokens,
	getValidOAuthToken,
	refreshClaudeToken,
	refreshClaudeTokenIfNeeded,
} from '../../lib/claude-oauth'

/** Create a mock DB with chainable select/update methods */
function createMockDb(workspace?: Record<string, unknown>) {
	const mockWhere = vi.fn().mockReturnValue({
		limit: vi.fn().mockResolvedValue(workspace ? [workspace] : []),
	})
	const mockUpdateWhere = vi.fn().mockResolvedValue(undefined)

	return {
		db: {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: mockWhere,
				}),
			}),
			update: vi.fn().mockReturnValue({
				set: vi.fn().mockReturnValue({
					where: mockUpdateWhere,
				}),
			}),
		} as unknown as Parameters<typeof getValidOAuthToken>[0],
		mockUpdateWhere,
	}
}

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
		expect(result!.accessToken).toBe('enc-access') // identity decrypt
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
		expect(result!.accessToken).toBe('new-access')
		expect(mockUpdateWhere).toHaveBeenCalled()
	})
})
