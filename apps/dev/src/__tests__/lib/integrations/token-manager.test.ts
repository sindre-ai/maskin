import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedProvider, StoredCredentials } from '../../../lib/integrations/types'

// Mock crypto module
vi.mock('../../../lib/crypto', () => ({
	decrypt: vi.fn((input: string) => input),
	encrypt: vi.fn((input: string) => input),
}))

// Mock OAuth2Handler — keep TokenRequestError as the real export so
// `err instanceof TokenRequestError` works inside token-manager.
const mockRefreshToken = vi.fn()
vi.mock('../../../lib/integrations/oauth/handler', async () => {
	const actual = await vi.importActual<typeof import('../../../lib/integrations/oauth/handler')>(
		'../../../lib/integrations/oauth/handler',
	)
	return {
		...actual,
		OAuth2Handler: vi.fn().mockImplementation(() => ({
			refreshToken: mockRefreshToken,
		})),
	}
})

import { decrypt, encrypt } from '../../../lib/crypto'
import { IntegrationAuthRevokedError } from '../../../lib/integrations/errors'
import { TokenRequestError } from '../../../lib/integrations/oauth/handler'
import { TokenManager } from '../../../lib/integrations/oauth/token-manager'

interface MockDb {
	db: Parameters<TokenManager['getValidToken']>[0]
	mockUpdateWhere: ReturnType<typeof vi.fn>
	updateSets: Array<Record<string, unknown>>
	insertValues: Array<Record<string, unknown>>
	selectCalls: { count: number }
}

/**
 * Create a mock DB. Pass a single integration to return on every select, or an
 * array to return each row in sequence (so a test can simulate the row being
 * updated between two getValidToken calls).
 */
function createMockDb(
	integration?: Record<string, unknown> | Array<Record<string, unknown>>,
): MockDb {
	const rows: Array<Record<string, unknown> | undefined> = Array.isArray(integration)
		? integration
		: [integration]
	const selectCalls = { count: 0 }

	const updateSets: Array<Record<string, unknown>> = []
	const insertValues: Array<Record<string, unknown>> = []
	// mockUpdateWhere must support two call patterns:
	//   await tx.update().set().where(...)                — used by doRefresh
	//   await tx.update().set().where(...).returning(...) — used by markRevoked
	// Attach .returning() directly onto the Promise so both patterns resolve correctly.
	const mockUpdateWhere = vi.fn().mockImplementation(() =>
		Object.assign(Promise.resolve(undefined), {
			returning: vi.fn().mockResolvedValue([{ id: 'integration-1' }]),
		}),
	)

	const db = {
		select: vi.fn().mockReturnValue({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					limit: vi.fn().mockImplementation(async () => {
						const row = rows[Math.min(selectCalls.count, rows.length - 1)]
						selectCalls.count += 1
						return row ? [row] : []
					}),
				}),
			}),
		}),
		update: vi.fn().mockReturnValue({
			set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
				updateSets.push(values)
				return { where: mockUpdateWhere }
			}),
		}),
		insert: vi.fn().mockReturnValue({
			values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
				insertValues.push(values)
				return Promise.resolve()
			}),
		}),
		// Simulates a Drizzle transaction by passing the same mock as the `tx` context.
		// The closure captures `db` by reference; by the time any test calls transaction(),
		// `db` is fully initialised.
		transaction: vi
			.fn()
			.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
	} as unknown as Parameters<TokenManager['getValidToken']>[0]

	return { db, mockUpdateWhere, updateSets, insertValues, selectCalls }
}

function makeCredentials(overrides?: Partial<StoredCredentials>): StoredCredentials {
	return {
		accessToken: 'access-token-123',
		refreshToken: 'refresh-token-456',
		expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
		...overrides,
	}
}

function makeIntegration(credentials: StoredCredentials, overrides?: Record<string, unknown>) {
	return {
		id: 'integration-1',
		workspaceId: 'ws-1',
		provider: 'test-provider',
		status: 'active',
		externalId: 'ext-1',
		credentials: JSON.stringify(credentials),
		config: {},
		createdBy: 'actor-1',
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	}
}

const oauth2Provider: ResolvedProvider = {
	config: {
		name: 'test-provider',
		displayName: 'Test Provider',
		auth: {
			type: 'oauth2',
			config: {
				authorizationUrl: 'https://provider.com/authorize',
				tokenUrl: 'https://provider.com/token',
				scopes: ['read'],
				clientIdEnv: 'TEST_CLIENT_ID',
				clientSecretEnv: 'TEST_CLIENT_SECRET',
			},
		},
	},
}

describe('TokenManager', () => {
	const manager = new TokenManager()

	beforeEach(() => {
		vi.mocked(decrypt).mockImplementation((input: string) => input)
		vi.mocked(encrypt).mockImplementation((input: string) => input)
		mockRefreshToken.mockReset()
	})

	it('throws when integration is not found', async () => {
		const { db } = createMockDb(undefined)

		await expect(manager.getValidToken(db, 'missing-id', oauth2Provider)).rejects.toThrow(
			'Integration missing-id not found',
		)
	})

	it('delegates to customAuth.getAccessToken for custom auth providers', async () => {
		const creds = makeCredentials({ installation_id: 'inst-42' })
		const { db } = createMockDb(makeIntegration(creds))
		const customProvider: ResolvedProvider = {
			config: {
				name: 'github',
				displayName: 'GitHub',
				auth: { type: 'oauth2_custom' },
			},
			customAuth: {
				getInstallUrl: vi.fn(),
				handleCallback: vi.fn(),
				getAccessToken: vi.fn().mockResolvedValue('github-token-abc'),
			},
		}

		const token = await manager.getValidToken(db, 'integration-1', customProvider)

		expect(token).toBe('github-token-abc')
		expect(customProvider.customAuth?.getAccessToken).toHaveBeenCalledWith(creds)
	})

	it('returns API key directly for api_key providers', async () => {
		const creds = makeCredentials({ accessToken: 'api-key-xyz' })
		const { db } = createMockDb(makeIntegration(creds))
		const apiKeyProvider: ResolvedProvider = {
			config: {
				name: 'simple',
				displayName: 'Simple',
				auth: {
					type: 'api_key',
					config: { headerName: 'Authorization', envKeyName: 'SIMPLE_KEY' },
				},
			},
		}

		const token = await manager.getValidToken(db, 'integration-1', apiKeyProvider)
		expect(token).toBe('api-key-xyz')
	})

	it('throws when api_key provider has no stored key', async () => {
		const creds = makeCredentials({ accessToken: undefined })
		const { db } = createMockDb(makeIntegration(creds))
		const apiKeyProvider: ResolvedProvider = {
			config: {
				name: 'simple',
				displayName: 'Simple',
				auth: {
					type: 'api_key',
					config: { headerName: 'Authorization', envKeyName: 'SIMPLE_KEY' },
				},
			},
		}

		await expect(manager.getValidToken(db, 'integration-1', apiKeyProvider)).rejects.toThrow(
			'no stored API key',
		)
	})

	it('returns token as-is when no expiry is set', async () => {
		const creds = makeCredentials({ expiresAt: undefined })
		const { db } = createMockDb(makeIntegration(creds))

		const token = await manager.getValidToken(db, 'integration-1', oauth2Provider)
		expect(token).toBe('access-token-123')
	})

	it('returns token as-is when still valid (far from expiry)', async () => {
		const creds = makeCredentials({ expiresAt: Date.now() + 60 * 60 * 1000 })
		const { db } = createMockDb(makeIntegration(creds))

		const token = await manager.getValidToken(db, 'integration-1', oauth2Provider)
		expect(token).toBe('access-token-123')
	})

	it('refreshes expired token and updates DB', async () => {
		const creds = makeCredentials({ expiresAt: Date.now() - 1000 })
		const { db, mockUpdateWhere } = createMockDb(makeIntegration(creds))

		mockRefreshToken.mockResolvedValue({
			accessToken: 'new-access-token',
			refreshToken: 'new-refresh-token',
			expiresAt: Date.now() + 3600 * 1000,
		})

		const token = await manager.getValidToken(db, 'integration-1', oauth2Provider)

		expect(token).toBe('new-access-token')
		expect(mockRefreshToken).toHaveBeenCalledWith('refresh-token-456')
		expect(encrypt).toHaveBeenCalled()
		expect(mockUpdateWhere).toHaveBeenCalled()
	})

	it('throws when token expired and no refresh token available', async () => {
		const creds = makeCredentials({ expiresAt: Date.now() - 1000, refreshToken: undefined })
		const { db } = createMockDb(makeIntegration(creds))

		await expect(manager.getValidToken(db, 'integration-1', oauth2Provider)).rejects.toThrow(
			'no refresh token available',
		)
	})

	describe('revocation handling', () => {
		it('short-circuits with auth_revoked when integration.status is revoked', async () => {
			const creds = makeCredentials()
			const { db } = createMockDb(makeIntegration(creds, { status: 'revoked' }))

			await expect(
				manager.getValidToken(db, 'integration-1', oauth2Provider),
			).rejects.toBeInstanceOf(IntegrationAuthRevokedError)
			expect(mockRefreshToken).not.toHaveBeenCalled()
		})

		it('flips status to revoked and throws auth_revoked on invalid_grant refresh', async () => {
			const creds = makeCredentials({ expiresAt: Date.now() - 1000 })
			const { db, updateSets } = createMockDb(makeIntegration(creds))

			mockRefreshToken.mockRejectedValue(
				new TokenRequestError(400, '{"error":"invalid_grant"}', 'invalid_grant'),
			)

			await expect(
				manager.getValidToken(db, 'integration-1', oauth2Provider),
			).rejects.toBeInstanceOf(IntegrationAuthRevokedError)

			// The status update is the side-effect we care about — credentials are NOT
			// re-written because the refresh failed.
			expect(updateSets).toContainEqual(expect.objectContaining({ status: 'revoked' }))
			expect(updateSets.find((set) => 'credentials' in set)).toBeUndefined()
		})

		it('re-throws non-invalid_grant TokenRequestError without flipping status', async () => {
			const creds = makeCredentials({ expiresAt: Date.now() - 1000 })
			const { db, updateSets } = createMockDb(makeIntegration(creds))

			mockRefreshToken.mockRejectedValue(
				new TokenRequestError(500, 'Internal Server Error', undefined),
			)

			await expect(manager.getValidToken(db, 'integration-1', oauth2Provider)).rejects.toThrow(
				/Token exchange failed: 500/,
			)
			expect(updateSets.find((set) => set.status === 'revoked')).toBeUndefined()
		})

		it('subsequent call after revocation short-circuits without calling refresh', async () => {
			const creds = makeCredentials({ expiresAt: Date.now() - 1000 })
			const { db } = createMockDb([
				makeIntegration(creds),
				makeIntegration(creds, { status: 'revoked' }),
			])

			mockRefreshToken.mockRejectedValue(
				new TokenRequestError(400, '{"error":"invalid_grant"}', 'invalid_grant'),
			)

			await expect(
				manager.getValidToken(db, 'integration-1', oauth2Provider),
			).rejects.toBeInstanceOf(IntegrationAuthRevokedError)
			expect(mockRefreshToken).toHaveBeenCalledTimes(1)

			await expect(
				manager.getValidToken(db, 'integration-1', oauth2Provider),
			).rejects.toBeInstanceOf(IntegrationAuthRevokedError)
			// No second outbound refresh — the status flip on the row is what gates
			// re-hitting the provider.
			expect(mockRefreshToken).toHaveBeenCalledTimes(1)
		})

		it('markRevoked sets status to revoked and logs an events row', async () => {
			const { db, updateSets, mockUpdateWhere, insertValues } = createMockDb(
				makeIntegration(makeCredentials()),
			)

			await manager.markRevoked(db, 'integration-1')

			expect(updateSets).toEqual([expect.objectContaining({ status: 'revoked' })])
			expect(mockUpdateWhere).toHaveBeenCalled()
			expect(insertValues).toContainEqual(
				expect.objectContaining({
					workspaceId: 'ws-1',
					actorId: 'actor-1',
					action: 'updated',
					entityType: 'integration',
					entityId: 'integration-1',
				}),
			)
		})
	})

	describe('concurrent refresh dedup', () => {
		it('dedupes parallel refresh attempts for the same integration', async () => {
			const creds = makeCredentials({ expiresAt: Date.now() - 1000 })
			const { db } = createMockDb(makeIntegration(creds))

			// Hold the refresh open until we manually resolve it so both callers
			// observe the in-flight Promise simultaneously.
			let resolveRefresh: (value: StoredCredentials) => void = () => {}
			const pending = new Promise<StoredCredentials>((resolve) => {
				resolveRefresh = resolve
			})
			mockRefreshToken.mockReturnValue(pending)

			const call1 = manager.getValidToken(db, 'integration-1', oauth2Provider)
			const call2 = manager.getValidToken(db, 'integration-1', oauth2Provider)

			resolveRefresh({
				accessToken: 'new-token',
				refreshToken: 'new-refresh',
				expiresAt: Date.now() + 3600 * 1000,
			})

			const [token1, token2] = await Promise.all([call1, call2])
			expect(token1).toBe('new-token')
			expect(token2).toBe('new-token')
			expect(mockRefreshToken).toHaveBeenCalledTimes(1)
		})

		it('clears the in-flight entry after refresh so a later expired call can refresh again', async () => {
			const expiredCreds = makeCredentials({ expiresAt: Date.now() - 1000 })
			const { db } = createMockDb([makeIntegration(expiredCreds), makeIntegration(expiredCreds)])

			mockRefreshToken.mockResolvedValue({
				accessToken: 'first',
				refreshToken: 'r1',
				expiresAt: Date.now() + 3600 * 1000,
			})
			await manager.getValidToken(db, 'integration-1', oauth2Provider)

			mockRefreshToken.mockResolvedValue({
				accessToken: 'second',
				refreshToken: 'r2',
				expiresAt: Date.now() + 3600 * 1000,
			})
			await manager.getValidToken(db, 'integration-1', oauth2Provider)

			expect(mockRefreshToken).toHaveBeenCalledTimes(2)
		})

		it('clears the in-flight entry after a failed refresh', async () => {
			const expiredCreds = makeCredentials({ expiresAt: Date.now() - 1000 })
			const { db } = createMockDb([makeIntegration(expiredCreds), makeIntegration(expiredCreds)])

			mockRefreshToken.mockRejectedValueOnce(new Error('transient network error'))
			await expect(manager.getValidToken(db, 'integration-1', oauth2Provider)).rejects.toThrow(
				'transient network error',
			)

			mockRefreshToken.mockResolvedValueOnce({
				accessToken: 'recovered',
				refreshToken: 'r',
				expiresAt: Date.now() + 3600 * 1000,
			})
			const token = await manager.getValidToken(db, 'integration-1', oauth2Provider)
			expect(token).toBe('recovered')
			expect(mockRefreshToken).toHaveBeenCalledTimes(2)
		})
	})
})
