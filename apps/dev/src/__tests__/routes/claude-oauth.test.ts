import { vi } from 'vitest'

vi.mock('../../lib/claude-oauth', () => ({
	encryptOAuthTokens: vi.fn().mockReturnValue({
		encryptedAccessToken: 'enc-access',
		encryptedRefreshToken: 'enc-refresh',
		expiresAt: Date.now() + 3600000,
		subscriptionType: 'pro',
	}),
	getValidOAuthToken: vi.fn(),
}))

import { getValidOAuthToken } from '../../lib/claude-oauth'
import { buildWorkspace, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: claudeOauthRoutes } = await import('../../routes/claude-oauth')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

const mockGetValid = getValidOAuthToken as ReturnType<typeof vi.fn>

describe('Claude OAuth Routes', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('DELETE /api/claude-oauth', () => {
		it('returns 200 when disconnected', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { encrypted: true } },
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonRequest('DELETE', '/api/claude-oauth', undefined, headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.success).toBe(true)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')

			const res = await app.request(jsonRequest('DELETE', '/api/claude-oauth', undefined, headers))

			expect(res.status).toBe(403)
		})

		it('clears only the primary slot, preserving backup and failover state', async () => {
			const backup = {
				encryptedAccessToken: 'backup-access',
				encryptedRefreshToken: 'backup-refresh',
				expiresAt: 222,
			}
			const failover = {
				active_slot: 'backup',
				last_primary_failure_at: 111,
				last_classified_reason: 'auth_failed',
			}
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: {
						primary: {
							encryptedAccessToken: 'primary-access',
							encryptedRefreshToken: 'primary-refresh',
							expiresAt: 111,
						},
						backup,
						failover,
					},
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonRequest('DELETE', '/api/claude-oauth', undefined, headers))

			expect(res.status).toBe(200)
			const [updatePayload] = calls.updates as Array<{ settings: { claude_oauth?: unknown } }>
			expect(updatePayload.settings.claude_oauth).toEqual({ backup, failover })
		})

		it('drops claude_oauth entirely when disconnecting a legacy primary-only row', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: {
						encryptedAccessToken: 'legacy-access',
						encryptedRefreshToken: 'legacy-refresh',
						expiresAt: 111,
					},
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonRequest('DELETE', '/api/claude-oauth', undefined, headers))

			expect(res.status).toBe(200)
			const [updatePayload] = calls.updates as Array<{ settings: { claude_oauth?: unknown } }>
			expect(updatePayload.settings.claude_oauth).toBeUndefined()
		})
	})

	describe('GET /api/claude-oauth/status', () => {
		it('returns connected and valid when token is good', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { encrypted: true, subscriptionType: 'pro', expiresAt: 99999 } },
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]
			mockGetValid.mockResolvedValue({
				tokens: { subscriptionType: 'pro', expiresAt: 99999 },
			})

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.connected).toBe(true)
			expect(body.valid).toBe(true)
		})

		it('returns not connected when no oauth data', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: {} })
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.connected).toBe(false)
			expect(body.valid).toBe(false)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')

			const res = await app.request(jsonGet('/api/claude-oauth/status', headers))

			expect(res.status).toBe(403)
		})
	})

	describe('POST /api/claude-oauth/import', () => {
		const importBody = {
			accessToken: 'access-123',
			refreshToken: 'refresh-123',
			expiresAt: Date.now() + 3600000,
		}

		it('returns 200 when tokens imported', async () => {
			const workspace = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/import', importBody, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.success).toBe(true)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/import', importBody, headers),
			)

			expect(res.status).toBe(403)
		})

		it('writes into the primary slot, preserving an existing backup and failover state', async () => {
			const backup = {
				encryptedAccessToken: 'backup-access',
				encryptedRefreshToken: 'backup-refresh',
				expiresAt: 222,
			}
			const failover = {
				active_slot: 'backup',
				last_primary_failure_at: 111,
				last_classified_reason: 'auth_failed',
			}
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					claude_oauth: {
						primary: {
							encryptedAccessToken: 'stale-primary-access',
							encryptedRefreshToken: 'stale-primary-refresh',
							expiresAt: 1,
						},
						backup,
						failover,
					},
				},
			})
			const { app, mockResults, calls } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/import', importBody, headers),
			)

			expect(res.status).toBe(200)
			const [updatePayload] = calls.updates as Array<{
				settings: { claude_oauth?: { primary?: unknown; backup?: unknown; failover?: unknown } }
			}>
			const nextOauth = updatePayload.settings.claude_oauth
			expect(nextOauth?.primary).toEqual({
				encryptedAccessToken: 'enc-access',
				encryptedRefreshToken: 'enc-refresh',
				expiresAt: expect.any(Number),
				subscriptionType: 'pro',
			})
			expect(nextOauth?.backup).toEqual(backup)
			expect(nextOauth?.failover).toEqual(failover)
		})
	})
})
