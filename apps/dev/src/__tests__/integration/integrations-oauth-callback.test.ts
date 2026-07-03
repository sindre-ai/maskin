import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

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
const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt } = await import('../../lib/crypto')

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
