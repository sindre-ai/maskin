import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, vi } from 'vitest'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	return {
		...actual,
		getProvider: vi.fn(actual.getProvider),
	}
})

const { getProvider } = await import('../../lib/integrations/registry')
const { trackIntegrationConnected } = await import('../../lib/analytics/integration-events')
const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt, decrypt } = await import('../../lib/crypto')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

// Regression coverage for the (workspace_id, provider, external_id) unique
// constraint: providers that resolve a STABLE externalId after token exchange
// (GitHub's installation_id, or a resolveExternalId provider like Google
// Calendar's account email) must refresh the existing active row on reconnect
// instead of promoting the fresh "pending" row — which would carry the same
// externalId and violate `integrations_ws_provider_external_uniq` at commit
// time. This exercises the real unique index against Postgres, not a mock.
describe('GET /api/integrations/:provider/callback — reconnect against a stable externalId', () => {
	it('refreshes the existing active row in place instead of violating the unique constraint', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const providerName = `test-email-provider-${randomBytes(4).toString('hex')}`
		const stableExternalId = 'reconnect@example.com'

		const testProvider: ResolvedProvider = {
			config: {
				name: providerName,
				displayName: `Test Email Provider ${providerName}`,
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
			},
			customAuth: {
				getInstallUrl: () => 'http://example.test/auth',
				handleCallback: async () => ({ accessToken: 'fresh-token' }),
				getAccessToken: async () => 'fresh-token',
			},
			// Stable per-account ID, resolved the same way regardless of how many
			// times the account reconnects — the exact shape of Google Calendar's
			// resolveExternalId (account email).
			resolveExternalId: async () => stableExternalId,
		}
		vi.mocked(getProvider).mockReturnValue(testProvider)

		// Seed the already-active integration, as if a prior connect completed.
		const [existingActive] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: providerName,
				status: 'active',
				externalId: stableExternalId,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token' })),
				createdBy: actorId,
			})
			.returning()

		// Seed the pending row the /connect step would have created for THIS attempt.
		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})

		const state = encrypt(JSON.stringify({ workspaceId: ws.id, actorId, ts: Date.now(), nonce }))

		const app = buildApp()
		// Before the fix, this request would UPDATE the pending row's external_id to
		// stableExternalId, colliding with existingActive and returning 500.
		const res = await app.request(
			`/api/integrations/${providerName}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
			// The callback requires the state-binding cookie POST /connect sets; this
			// test seeds the pending row directly, so it supplies the cookie too.
			{ headers: { cookie: `maskin_oauth_nonce_${providerName}=${nonce}` } },
		)

		expect(res.status).toBe(302)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, providerName)))

		// Exactly one row survives — the pending row was deleted, not promoted into
		// a duplicate that would violate the unique index.
		expect(rows).toHaveLength(1)
		expect(rows[0].id).toBe(existingActive.id)
		expect(rows[0].status).toBe('active')
		expect(rows[0].externalId).toBe(stableExternalId)
	})
})

// integration_connected must count real new connects only. A reconnect onto a
// row that was already active refreshes credentials in place but is not a new
// connect, so it must not emit a second event.
describe('GET /api/integrations/:provider/callback — integration_connected emit', () => {
	beforeEach(() => {
		vi.mocked(trackIntegrationConnected).mockClear()
	})

	const STABLE_EXTERNAL_ID = 'emit@example.com'

	async function runCallback(opts: {
		existingStatus?: 'active' | 'revoked' | 'error'
		postInstall?: () => Promise<void>
	}) {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const providerName = `test-emit-provider-${randomBytes(4).toString('hex')}`

		const testProvider: ResolvedProvider = {
			config: {
				name: providerName,
				displayName: `Test Emit Provider ${providerName}`,
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
			},
			customAuth: {
				getInstallUrl: () => 'http://example.test/auth',
				handleCallback: async () => ({ accessToken: 'fresh-token' }),
				getAccessToken: async () => 'fresh-token',
			},
			resolveExternalId: async () => STABLE_EXTERNAL_ID,
			...(opts.postInstall ? { postInstall: opts.postInstall } : {}),
		}
		vi.mocked(getProvider).mockReturnValue(testProvider)

		if (opts.existingStatus) {
			await db.insert(integrations).values({
				workspaceId: ws.id,
				provider: providerName,
				status: opts.existingStatus,
				externalId: STABLE_EXTERNAL_ID,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token' })),
				createdBy: actorId,
			})
		}

		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
		const state = encrypt(JSON.stringify({ workspaceId: ws.id, actorId, ts: Date.now(), nonce }))

		const res = await buildApp().request(
			`/api/integrations/${providerName}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
			{ headers: { cookie: `maskin_oauth_nonce_${providerName}=${nonce}` } },
		)
		return { res, providerName, workspaceId: ws.id }
	}

	it('emits exactly once on a first-time connect', async () => {
		const { res, providerName, workspaceId } = await runCallback({})

		expect(res.status).toBe(302)
		expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
		expect(trackIntegrationConnected).toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerName, workspaceId, authType: 'oauth' }),
		)
	})

	it('does not emit when reconnecting onto an already-active row, but still refreshes it', async () => {
		const { res, providerName, workspaceId } = await runCallback({ existingStatus: 'active' })

		expect(res.status).toBe(302)
		expect(trackIntegrationConnected).not.toHaveBeenCalled()

		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, providerName)),
			)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('active')
		expect(JSON.parse(decrypt(rows[0].credentials))).toMatchObject({ accessToken: 'fresh-token' })
	})

	it.each(['revoked', 'error'] as const)(
		'emits exactly once when reconnecting onto a %s row',
		async (existingStatus) => {
			const { res } = await runCallback({ existingStatus })

			expect(res.status).toBe(302)
			expect(trackIntegrationConnected).toHaveBeenCalledTimes(1)
		},
	)

	it('emits nothing when postInstall fails', async () => {
		const { res } = await runCallback({
			postInstall: async () => {
				throw new Error('postInstall boom')
			},
		})

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain('error=post_install_failed')
		expect(trackIntegrationConnected).not.toHaveBeenCalled()
	})
})
