import { randomBytes } from 'node:crypto'
import { type ScopeGrant, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

// No network: Meet's People id lookup is stubbed, everything else is the real route.
vi.mock('../../lib/integrations/providers/google-meet/resolve-id', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/google-meet/resolve-id')
	>('../../lib/integrations/providers/google-meet/resolve-id')
	return { ...actual, resolveMeetPeopleId: vi.fn(async () => 'people/fake-id') }
})

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	return { ...actual, getProvider: vi.fn(actual.getProvider) }
})

const { getProvider } = await import('../../lib/integrations/registry')
const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt } = await import('../../lib/crypto')
const { getCredential } = await import('../../lib/integrations/lookup')
const { readContextFor } = await import('../../lib/integrations/read-context')
const { verifyCredentialAccessChain } = await import('../../lib/integrations/credential-audit')

/**
 * A Meet connect made after migration 0088 must be readable through
 * getCredential, and a reconnect must never overwrite grants. The route is real,
 * against real Postgres; only the OAuth handshake is stubbed.
 */

const MEET_ACCOUNT = 'meet-account@example.test'

function stubProvider(name: string): ResolvedProvider {
	return {
		config: {
			name,
			displayName: `Stub ${name}`,
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
			getInstallUrl: (state) => `http://example.test/auth?state=${encodeURIComponent(state)}`,
			handleCallback: async () => ({ accessToken: 'fake-access-token-not-real' }),
			getAccessToken: async () => 'fake-access-token-not-real',
		},
		resolveExternalId: async () => MEET_ACCOUNT,
	}
}

const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })

/** POST /connect, then GET /callback the way the browser would. */
async function connectAndCallback(workspaceId: string, provider: string) {
	vi.mocked(getProvider).mockReturnValue(stubProvider(provider))
	const connectRes = await app.request(`/api/integrations/${provider}/connect`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId },
		body: '{}',
	})
	expect(connectRes.status).toBe(200)
	const { install_url } = (await connectRes.json()) as { install_url: string }
	const state = new URL(install_url).searchParams.get('state') ?? ''
	const cookie = (connectRes.headers.get('set-cookie') ?? '').split(';')[0]
	const cbRes = await app.request(
		`/api/integrations/${provider}/callback?state=${encodeURIComponent(state)}&code=irrelevant`,
		{ headers: { cookie } },
	)
	expect(cbRes.status).toBe(302)
}

const rowsFor = (workspaceId: string, provider: string) =>
	db
		.select()
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))

beforeEach(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.MASKIN_PUBLIC_URL = 'http://localhost:3000'
})

describe('google-meet connect writes the workspace grant', () => {
	it('a connect made after the backfill reads successfully with one audit row', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		await connectAndCallback(ws.id, 'google-meet')

		const [row] = await rowsFor(ws.id, 'google-meet')
		expect(row.status).toBe('active')
		expect(row.scopeGrants).toEqual([{ kind: 'workspace' }])
		const credential = await getCredential(db, ws.id, row.id, readContextFor(actorId))
		expect(JSON.parse(credential.value)).toMatchObject({
			accessToken: 'fake-access-token-not-real',
		})
		const logs = await sql`SELECT 1 FROM credential_access_log WHERE workspace_id = ${ws.id}`
		expect(logs).toHaveLength(1)
		expect(await verifyCredentialAccessChain(db, ws.id)).toMatchObject({ ok: true, rows: 1 })
	})

	async function seedActive(workspaceId: string, grants: ScopeGrant[]) {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'google-meet',
				status: 'active',
				externalId: MEET_ACCOUNT,
				credentials: encrypt(JSON.stringify({ accessToken: 'stale-token-not-real' })),
				scopeGrants: grants,
				createdBy: getTestActorId(),
			})
			.returning()
		return row
	}

	it('a reconnect keeps grants that are already there', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const actorGrant: ScopeGrant[] = [{ kind: 'actor', actorId }]
		const existing = await seedActive(ws.id, actorGrant)

		await connectAndCallback(ws.id, 'google-meet')

		const rows = await rowsFor(ws.id, 'google-meet')
		expect(rows).toHaveLength(1)
		expect(rows[0].id).toBe(existing.id)
		expect(rows[0].scopeGrants).toEqual(actorGrant)
	})

	it('a reconnect fills the workspace grant in when the row has none', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const existing = await seedActive(ws.id, [])

		await connectAndCallback(ws.id, 'google-meet')

		const rows = await rowsFor(ws.id, 'google-meet')
		expect(rows).toHaveLength(1)
		expect(rows[0].id).toBe(existing.id)
		expect(rows[0].scopeGrants).toEqual([{ kind: 'workspace' }])
	})

	it('another provider keeps the empty default (fail closed)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const provider = `test-provider-${randomBytes(4).toString('hex')}`

		await connectAndCallback(ws.id, provider)

		const [row] = await rowsFor(ws.id, provider)
		expect(row.status).toBe('active')
		expect(row.scopeGrants).toEqual([])
	})
})
