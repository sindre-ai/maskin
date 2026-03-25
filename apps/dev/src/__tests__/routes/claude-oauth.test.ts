import { vi } from 'vitest'

vi.mock('../../lib/claude-oauth', () => ({
	exchangeCodeForTokens: vi.fn(),
	encryptOAuthTokens: vi.fn().mockReturnValue({
		encryptedAccessToken: 'enc-access',
		encryptedRefreshToken: 'enc-refresh',
		expiresAt: Date.now() + 3600000,
		subscriptionType: 'pro',
	}),
	getValidOAuthToken: vi.fn(),
	CLAUDE_AUTHORIZE_URL: 'https://claude.ai/oauth/authorize',
	CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
}))

import {
	exchangeCodeForTokens,
	getValidOAuthToken,
} from '../../lib/claude-oauth'
import { buildWorkspace, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: claudeOauthRoutes } = await import('../../routes/claude-oauth')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

const mockExchange = exchangeCodeForTokens as ReturnType<typeof vi.fn>
const mockGetValid = getValidOAuthToken as ReturnType<typeof vi.fn>

describe('Claude OAuth Routes', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('POST /api/claude-oauth/exchange', () => {
		const exchangeBody = {
			code: 'auth-code-123',
			code_verifier: 'verifier-123',
			redirect_uri: 'http://localhost:3000/callback',
			state: 'state-123',
		}

		it('returns 200 when tokens exchanged successfully', async () => {
			const workspace = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [
				[buildWorkspaceMember()], // member check
				[workspace], // workspace fetch
			]
			mockExchange.mockResolvedValue({
				accessToken: 'access-123',
				refreshToken: 'refresh-123',
				expiresAt: Date.now() + 3600000,
				subscriptionType: 'pro',
			})

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/exchange', exchangeBody, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.success).toBe(true)
		})

		it('returns 400 when token exchange fails', async () => {
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.select = [buildWorkspaceMember()]
			mockExchange.mockRejectedValue(new Error('Exchange failed'))

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/exchange', exchangeBody, headers),
			)

			expect(res.status).toBe(400)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/exchange', exchangeBody, headers),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('DELETE /api/claude-oauth', () => {
		it('returns 200 when disconnected', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { encrypted: true } },
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [
				[buildWorkspaceMember()],
				[workspace],
			]

			const res = await app.request(
				jsonRequest('DELETE', '/api/claude-oauth', undefined, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.success).toBe(true)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')

			const res = await app.request(
				jsonRequest('DELETE', '/api/claude-oauth', undefined, headers),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('GET /api/claude-oauth/status', () => {
		it('returns connected and valid when token is good', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: { claude_oauth: { encrypted: true, subscriptionType: 'pro', expiresAt: 99999 } },
			})
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.selectQueue = [
				[buildWorkspaceMember()],
				[workspace],
			]
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
			mockResults.selectQueue = [
				[buildWorkspaceMember()],
				[workspace],
			]

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
			mockResults.selectQueue = [
				[buildWorkspaceMember()],
				[workspace],
			]

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
	})

	describe('POST /api/claude-oauth/start', () => {
		it('returns 200 with auth_url and flow_id', async () => {
			const { app, mockResults } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')
			mockResults.select = [buildWorkspaceMember()]

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/start', undefined, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.auth_url).toBeDefined()
			expect(body.flow_id).toBeDefined()
			expect(body.auth_url).toContain('oauth')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')

			const res = await app.request(
				jsonRequest('POST', '/api/claude-oauth/start', undefined, headers),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('GET /api/claude-oauth/flow/:flowId', () => {
		it('returns error status for unknown flow', async () => {
			const { app } = createTestApp(claudeOauthRoutes, '/api/claude-oauth')

			const res = await app.request(jsonGet('/api/claude-oauth/flow/unknown-flow-id'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.status).toBe('error')
			expect(body.error).toContain('not found')
		})
	})
})
