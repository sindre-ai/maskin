import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedProvider, StoredCredentials } from '../../../lib/integrations/types'

// Mock crypto module
vi.mock('../../../lib/crypto', () => ({
	decrypt: vi.fn((input: string) => input),
	encrypt: vi.fn((input: string) => input),
}))

// Mock OAuth2Handler
const mockRefreshToken = vi.fn()
vi.mock('../../../lib/integrations/oauth/handler', () => ({
	OAuth2Handler: vi.fn().mockImplementation(() => ({
		refreshToken: mockRefreshToken,
	})),
}))

import { decrypt, encrypt } from '../../../lib/crypto'
import { TokenManager } from '../../../lib/integrations/oauth/token-manager'

/** Create a mock DB with chainable select/update methods */
function createMockDb(integration?: Record<string, unknown>) {
	const mockWhere = vi.fn().mockReturnValue({
		limit: vi.fn().mockResolvedValue(integration ? [integration] : []),
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
		} as unknown as Parameters<TokenManager['getValidToken']>[0],
		mockUpdateWhere,
	}
}

function makeCredentials(overrides?: Partial<StoredCredentials>): StoredCredentials {
	return {
		accessToken: 'access-token-123',
		refreshToken: 'refresh-token-456',
		expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
		...overrides,
	}
}

function makeIntegration(credentials: StoredCredentials) {
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
})
