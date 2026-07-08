import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, vi } from 'vitest'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { buildIntegration, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	// Default behavior delegates to the real registry so the rest of this file's
	// tests keep hitting the real provider configs. Per-test mockReturnValueOnce
	// swaps in a substitute when needed.
	return {
		...actual,
		getProvider: vi.fn(actual.getProvider),
		listProviders: vi.fn(actual.listProviders),
	}
})

// Stub fetchInstallationOwnerLogin so the github callback path doesn't make a
// live api.github.com call during unit tests. Keep `githubAuth` as-is so the
// registry's customAuth handler still works.
vi.mock('../../lib/integrations/providers/github/auth', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/github/auth')
	>('../../lib/integrations/providers/github/auth')
	return {
		...actual,
		fetchInstallationOwnerLogin: vi.fn(async (installationId: string) => `owner-${installationId}`),
	}
})

const { getProvider } = await import('../../lib/integrations/registry')
const { default: integrationsRoutes, webhookApp } = await import('../../routes/integrations')
const { fetchInstallationOwnerLogin } = await import('../../lib/integrations/providers/github/auth')

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

		it('activates an api_key provider (posthog) immediately and stores the request key in credentials', async () => {
			const originalFrontendUrl = process.env.FRONTEND_URL
			process.env.FRONTEND_URL = 'http://localhost:5173'
			try {
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.insert = [{ id: '11111111-1111-1111-1111-111111111111' }]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/integrations/posthog/connect',
						{ api_key: 'phx_test_personal_key' },
						{
							'x-workspace-id': wsId,
						},
					),
				)

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body.install_url).toBe(`http://localhost:5173/${wsId}/settings/integrations`)

				const integrationInsert = calls.inserts[0] as Record<string, unknown>
				expect(integrationInsert.provider).toBe('posthog')
				expect(integrationInsert.status).toBe('active')
				expect(integrationInsert.externalId).toBe('posthog-personal')
				expect(typeof integrationInsert.credentials).toBe('string')
				expect((integrationInsert.credentials as string).length).toBeGreaterThan(0)
				// Credentials must be encrypted, not the plain request value
				expect(integrationInsert.credentials).not.toBe('phx_test_personal_key')

				const eventInsert = calls.inserts[1] as Record<string, unknown>
				expect(eventInsert.entityType).toBe('integration')
				expect(eventInsert.action).toBe('created')
				expect((eventInsert.data as Record<string, unknown>).provider).toBe('posthog')
				expect((eventInsert.data as Record<string, unknown>).auth_type).toBe('api_key')
			} finally {
				if (originalFrontendUrl === undefined) {
					Reflect.deleteProperty(process.env, 'FRONTEND_URL')
				} else {
					process.env.FRONTEND_URL = originalFrontendUrl
				}
			}
		})

		it('refreshes an existing active api_key integration instead of inserting a duplicate', async () => {
			try {
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.selectQueue = [[{ id: 'existing-integration-id' }]]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/integrations/posthog/connect',
						{ api_key: 'phx_test_personal_key' },
						{
							'x-workspace-id': wsId,
						},
					),
				)

				expect(res.status).toBe(200)
				expect(calls.inserts.length).toBeGreaterThanOrEqual(1)
				expect(
					calls.inserts.find(
						(entry: Record<string, unknown>) =>
							entry.action === 'created' &&
							entry.entityType === 'integration' &&
							(entry.data as Record<string, unknown>)?.provider === 'posthog',
					),
				).toMatchObject({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					action: 'created',
					entityType: 'integration',
					data: {
						provider: 'posthog',
						external_id: 'posthog-personal',
						auth_type: 'api_key',
					},
				})
			} finally {
				// No env state to restore for PostHog anymore.
			}
		})

		it('returns 400 when api_key provider request body is missing', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/posthog/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('requires an API key')
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
					Reflect.deleteProperty(process.env, 'SLACK_CLIENT_ID')
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
					Reflect.deleteProperty(process.env, 'SLACK_CLIENT_ID')
				} else {
					process.env.SLACK_CLIENT_ID = originalClientId
				}
				if (originalClientSecret === undefined) {
					Reflect.deleteProperty(process.env, 'SLACK_CLIENT_SECRET')
				} else {
					process.env.SLACK_CLIENT_SECRET = originalClientSecret
				}
			}
		})

		it('uses installation_id as external ID and persists config.owner_login in github callback', async () => {
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
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
				[], // existing-active-row lookup — first time seeing this installation
			]

			// GitHub callback with installation_id — uses installation_id as externalId
			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=42`,
				),
			)

			expect(res.status).toBe(302)
			expect(fetchInstallationOwnerLogin).toHaveBeenCalledWith('42')

			const activateCall = calls.updates.find(
				(u): u is { status?: string; externalId?: string; config?: { owner_login?: string } } =>
					!!u && typeof u === 'object' && (u as { status?: string }).status === 'active',
			)
			expect(activateCall).toBeDefined()
			expect(activateCall?.externalId).toBe('42')
			expect(activateCall?.config).toEqual({
				system_actor_id: 'system-actor-id',
				owner_login: 'owner-42',
			})
		})

		it('connecting a second github installation creates a new row and leaves the first untouched', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'second-install-nonce'
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
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup (the row for THIS connect)
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
				// existing-active-row lookup for installation_id=200 — empty because the
				// already-connected installation_id=100 doesn't match this externalId
				[],
			]

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=200`,
				),
			)

			expect(res.status).toBe(302)

			// Exactly one update — the pending row activates as a NEW active row.
			// Crucially: nothing else got UPDATE'd (the first installation row, if it
			// existed, would have its own externalId=100 and the WHERE clause never
			// matches it).
			const activateCalls = calls.updates.filter(
				(u) => u && typeof u === 'object' && (u as { status?: string }).status === 'active',
			)
			expect(activateCalls).toHaveLength(1)
			expect(activateCalls[0]).toMatchObject({
				status: 'active',
				externalId: '200',
				config: { system_actor_id: 'system-actor-id', owner_login: 'owner-200' },
			})

			// No refresh-shaped update (no status field set) — the existing row was untouched.
			const refreshCalls = calls.updates.filter(
				(u) =>
					u &&
					typeof u === 'object' &&
					!('status' in (u as Record<string, unknown>)) &&
					'credentials' in (u as Record<string, unknown>),
			)
			expect(refreshCalls).toHaveLength(0)
		})

		it('re-connecting the same github installation refreshes the existing row in place (no duplicate)', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'reconnect-nonce'
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
			const existingActive = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				status: 'active',
				externalId: '300',
				config: { system_actor_id: 'system-actor-id', owner_login: 'owner-300' },
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
				[existingActive], // existing-active-row lookup — finds the already-active installation
			]

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&installation_id=300`,
				),
			)

			expect(res.status).toBe(302)

			// Refresh-shaped update: re-activates the existing row with fresh
			// credentials + config but does NOT set externalId — that's how it
			// differs from promoting the pending row, which rewrites externalId.
			// (status IS set since the refresh branch also revives revoked rows.)
			const refreshCall = calls.updates.find(
				(u) =>
					u &&
					typeof u === 'object' &&
					'credentials' in (u as Record<string, unknown>) &&
					!('externalId' in (u as Record<string, unknown>)),
			) as
				| { status?: string; credentials?: string; config?: { owner_login?: string } }
				| undefined
			expect(refreshCall).toBeDefined()
			expect(refreshCall?.status).toBe('active')
			expect(refreshCall?.config).toEqual({
				system_actor_id: 'system-actor-id',
				owner_login: 'owner-300',
			})

			// No promote-shaped update — the pending row was deleted, not rewritten
			// to the installation's externalId.
			const promoteCalls = calls.updates.filter(
				(u) => u && typeof u === 'object' && 'externalId' in (u as Record<string, unknown>),
			)
			expect(promoteCalls).toHaveLength(0)
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

	describe('GET /api/integrations/:id/slack/conversations', () => {
		it('returns 200 with normalized list when integration is active Slack', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const { _resetSlackCaches } = await import('../../lib/integrations/providers/slack/client')
			_resetSlackCaches()

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'active',
				credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-test' })),
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[integration], [integration]] // route lookup, token lookup

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						channels: [
							{ id: 'C1', name: 'general', is_channel: true },
							{ id: 'G1', name: 'leadership', is_private: true },
						],
					}),
				),
			)

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/conversations`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			expect(body[0]).toMatchObject({ id: 'C1', name: 'general', is_channel: true })
			expect(body[1]).toMatchObject({ id: 'G1', name: 'leadership', is_private: true })
			fetchSpy.mockRestore()
		})

		it('returns 404 when integration is not Slack', async () => {
			const integration = buildIntegration({ workspaceId: wsId, provider: 'github' })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [] // filter on provider='slack' returns nothing

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/conversations`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when types query param contains invalid value', async () => {
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'active',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const res = await app.request(
				jsonGet(
					`/api/integrations/${integration.id}/slack/conversations?types=public_channel,nope`,
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/integrations/:id/slack/users', () => {
		it('returns 200 with filtered active users', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const { _resetSlackCaches } = await import('../../lib/integrations/providers/slack/client')
			_resetSlackCaches()

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'active',
				credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-test' })),
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[integration], [integration]]

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						members: [
							{ id: 'U1', name: 'alice', real_name: 'Alice', is_bot: false },
							{ id: 'U2', name: 'bob', deleted: true },
							{ id: 'U3', name: 'botty', real_name: 'Botty', is_bot: true },
						],
					}),
				),
			)

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/users`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2) // deleted user filtered out
			expect(body.map((u: { id: string }) => u.id)).toEqual(['U1', 'U3'])
			fetchSpy.mockRestore()
		})

		it('returns 404 when integration is for a different workspace', async () => {
			const integration = buildIntegration({
				workspaceId: 'other-workspace-id',
				provider: 'slack',
				status: 'active',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [] // workspaceId filter excludes it

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/users`, {
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

		// Guards DOD #1 of PR #492: when a provider opts into asyncProcessing, the
		// route must ack the webhook before the fan-out work finishes. If a regression
		// puts fan-out back on the hot path, the response would block on `fanOutGate`
		// and this test would time out.
		it('with asyncProcessing returns before webhookFanOut settles and acks { queued, workspaces }', async () => {
			const providerName = 'test-async-provider'
			const installationId = 'inst-async'

			let resolveFanOut!: () => void
			const fanOutGate = new Promise<void>((resolve) => {
				resolveFanOut = resolve
			})
			let fanOutStarted = false

			const normalizedEvent = {
				entityType: 'test.event',
				action: 'created' as const,
				installationId,
				data: { hello: 'world' },
			}

			const testProvider: ResolvedProvider = {
				config: {
					name: providerName,
					displayName: 'Test Async Provider',
					auth: {
						type: 'oauth2',
						config: {
							authorizationUrl: 'http://example.test/auth',
							tokenUrl: 'http://example.test/token',
							scopes: [],
							clientIdEnv: 'TEST_CLIENT_ID',
							clientSecretEnv: 'TEST_CLIENT_SECRET',
						},
					},
					webhook: { type: 'custom' },
				},
				customWebhookVerifier: () => true,
				customNormalizer: () => normalizedEvent,
				asyncProcessing: true,
				webhookFanOut: async () => {
					fanOutStarted = true
					await fanOutGate
					return [normalizedEvent]
				},
			}

			vi.mocked(getProvider).mockReturnValueOnce(testProvider)

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: providerName,
				status: 'active',
				externalId: installationId,
				config: { system_actor_id: 'system-actor-id' },
			})

			const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
			mockResults.select = [integration]

			const responsePromise = app.request(
				jsonRequest('POST', `/api/webhooks/${providerName}`, { hello: 'world' }),
			)

			const timeoutHandle = { id: undefined as ReturnType<typeof setTimeout> | undefined }
			const timeoutPromise = new Promise<'timeout'>((resolve) => {
				timeoutHandle.id = setTimeout(() => resolve('timeout'), 1000)
			})

			const winner = await Promise.race([
				responsePromise.then(() => 'response' as const),
				fanOutGate.then(() => 'fan-out-settled' as const),
				timeoutPromise,
			])
			if (timeoutHandle.id) clearTimeout(timeoutHandle.id)
			expect(winner).toBe('response')

			const res = await responsePromise
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual({ ok: true, queued: 1, workspaces: 1 })
			expect(fanOutStarted).toBe(true)

			// Let the queued background work complete so it doesn't bleed into other tests.
			resolveFanOut()
			await new Promise<void>((r) => setImmediate(r))
		})
	})
})
