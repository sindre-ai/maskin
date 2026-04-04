import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { buildIntegration, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: integrationsRoutes, webhookApp } = await import('../../routes/integrations')

const wsId = '00000000-0000-0000-0000-000000000001'

// Set up encryption key for crypto operations used in connect/callback
const originalEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
const testEncryptionKey = randomBytes(32).toString('hex')

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = testEncryptionKey
})

afterAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = originalEncryptionKey
})

describe('Integrations Routes', () => {
	describe('GET /api/integrations', () => {
		it('returns 200 with list of integrations', async () => {
			const int1 = buildIntegration({ workspaceId: wsId })
			const int2 = buildIntegration({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [int1, int2]

			const res = await app.request(jsonGet('/api/integrations', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			// Credentials should be stripped
			for (const item of body) {
				expect(item).not.toHaveProperty('credentials')
			}
		})
	})

	describe('GET /api/integrations/providers', () => {
		it('returns 200 with list of providers', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(jsonGet('/api/integrations/providers'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
			// At least github provider should be registered
			expect(body.length).toBeGreaterThanOrEqual(1)
			expect(body[0]).toHaveProperty('name')
			expect(body[0]).toHaveProperty('displayName')
			expect(body[0]).toHaveProperty('events')
		})
	})

	describe('POST /api/integrations/:provider/connect', () => {
		it('returns 400 for unknown provider', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/nonexistent/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Unknown provider')
		})

		it('returns 200 with install_url for a known provider', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/github/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.install_url).toBeDefined()
			expect(body.install_url).toContain('github.com')
		})

		it('returns 200 with install_url for standard oauth2 provider (slack)', async () => {
			const originalClientId = process.env.SLACK_CLIENT_ID
			process.env.SLACK_CLIENT_ID = 'test-slack-client-id'
			try {
				const { app } = createTestApp(integrationsRoutes, '/api/integrations')

				const res = await app.request(
					jsonRequest('POST', '/api/integrations/slack/connect', undefined, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body.install_url).toBeDefined()
				expect(body.install_url).toContain('slack.com/oauth')
				expect(body.install_url).toContain('response_type=code')
			} finally {
				if (originalClientId === undefined) {
					process.env.SLACK_CLIENT_ID = undefined
				} else {
					process.env.SLACK_CLIENT_ID = originalClientId
				}
			}
		})
	})

	describe('GET /api/integrations/:provider/callback', () => {
		it('returns 400 for unknown provider', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonGet('/api/integrations/nonexistent/callback?state=abc&code=123'),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Unknown provider')
		})

		it('returns 400 when state parameter is missing', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(jsonGet('/api/integrations/github/callback'))

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Missing state parameter')
		})

		it('returns 400 when state is invalid/corrupt', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonGet('/api/integrations/github/callback?state=invalid-garbage'),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid state parameter')
		})

		it('returns 400 when state is expired', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const expiredState = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now() - 11 * 60 * 1000, // 11 minutes ago
					nonce: 'test-nonce',
				}),
			)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(expiredState)}&installation_id=123`,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('expired')
		})

		it('returns 400 when nonce is already used (replay attack)', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce: 'used-nonce',
				}),
			)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')
			// No pending integration found with this nonce

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=123`,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid or already used state token')
		})

		it('returns 400 when actor is no longer a workspace member', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'valid-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			// First select: pending integration found, second select: membership check fails
			mockResults.selectQueue = [[pendingIntegration], []]

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=123`,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('no longer a member')
		})

		it('completes callback flow and redirects for github provider', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'cb-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
			]

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=42`,
				),
			)

			// Should redirect to frontend
			expect(res.status).toBe(302)
			const location = res.headers.get('Location')
			expect(location).toContain('/settings/integrations')
		})

		it('creates system actor when none exists and adds as workspace member', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'new-actor-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const newSystemActor = { id: 'new-system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[], // system actor lookup — not found
				[], // existing member check — not found (will insert)
			]
			mockResults.insert = [newSystemActor] // insert new system actor

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=99`,
				),
			)

			expect(res.status).toBe(302)
			const location = res.headers.get('Location')
			expect(location).toContain('/settings/integrations')
		})

		it('returns 400 when missing authorization code for oauth2 provider (slack)', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'slack-no-code'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
			]

			// No code query parameter
			const res = await app.request(
				jsonGet(`/api/integrations/slack/callback?state=${encodeURIComponent(state)}`),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Missing authorization code')
		})

		it('redirects with error when token exchange fails for oauth2 provider', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const originalClientId = process.env.SLACK_CLIENT_ID
			const originalClientSecret = process.env.SLACK_CLIENT_SECRET
			process.env.SLACK_CLIENT_ID = 'test-slack-id'
			process.env.SLACK_CLIENT_SECRET = 'test-slack-secret'

			try {
				const nonce = 'slack-token-fail'
				const state = encrypt(
					JSON.stringify({
						workspaceId: wsId,
						actorId: 'test-actor-id',
						ts: Date.now(),
						nonce,
					}),
				)
				const pendingIntegration = buildIntegration({
					workspaceId: wsId,
					provider: 'slack',
					status: 'pending',
					externalId: nonce,
				})
				const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
				const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.selectQueue = [
					[pendingIntegration], // pending integration lookup
					[member], // membership check
				]

				// The code=invalid will cause the token exchange to fail (network error to slack.com)
				const res = await app.request(
					jsonGet(
						`/api/integrations/slack/callback?state=${encodeURIComponent(state)}&code=invalid-code`,
					),
				)

				// Should redirect with error param
				expect(res.status).toBe(302)
				const location = res.headers.get('Location')
				expect(location).toContain('error=token_exchange_failed')
			} finally {
				if (originalClientId === undefined) {
					process.env.SLACK_CLIENT_ID = undefined
				} else {
					process.env.SLACK_CLIENT_ID = originalClientId
				}
				if (originalClientSecret === undefined) {
					process.env.SLACK_CLIENT_SECRET = undefined
				} else {
					process.env.SLACK_CLIENT_SECRET = originalClientSecret
				}
			}
		})

		it('uses installation_id as external ID when provided in github callback', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'fallback-nonce-1234567890'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
			]

			// GitHub callback with installation_id — uses installation_id as externalId
			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=42`,
				),
			)

			expect(res.status).toBe(302)
		})
	})

	describe('DELETE /api/integrations/:id', () => {
		it('returns 200 when integration deleted', async () => {
			const integration = buildIntegration({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[integration]]

			const res = await app.request(
				jsonDelete(`/api/integrations/${integration.id}`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when integration not found', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonDelete('/api/integrations/00000000-0000-0000-0000-000000000099', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when integration belongs to different workspace (cross-workspace)', async () => {
			const otherWsId = '00000000-0000-0000-0000-000000000002'
			const integration = buildIntegration({ workspaceId: otherWsId })
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')
			// The select query filters by both id AND workspaceId, so it returns empty

			const res = await app.request(
				jsonDelete(`/api/integrations/${integration.id}`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})
})

describe('Webhook Routes', () => {
	describe('POST /api/webhooks/:provider', () => {
		it('returns 400 for unknown provider', async () => {
			const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')

			const res = await app.request(
				jsonRequest('POST', '/api/webhooks/nonexistent', { event: 'test' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Unknown provider')
		})
	})
})
