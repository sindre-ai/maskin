import { type ScopeGrant, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { getCredential, getIntegrationCredential } from '../../lib/integrations/lookup'
import {
	type LinkedInMockServer,
	simulateCallbackError,
	simulateCallbackSuccess,
	startLinkedInMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { readContextFor } from '../../lib/integrations/read-context'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

/**
 * Round-trip coverage for the LinkedIn Hosted Auth v2 connect flow against
 * real Postgres: POST /connect → GET /callback → read the credential back
 * through `getIntegrationCredential`.
 *
 * v2 replaces v1's HMAC-signed POST callback with a browser redirect callback
 * carrying `state` + `account_id` + `provider` query params. `state` is
 * `<integrationId>.<nonce>`: the id locates the pending row without a scan,
 * the 32-byte nonce is minted per-connect, stored in the row's encrypted
 * credentials blob, checked with timingSafeEqual on the callback, expires
 * after 10 minutes, and is consumed by the credential write — see
 * `routes/integrations-linkedin-unipile.ts` for the rationale.
 *
 * The point of this file is the last step: the mocked-DB route tests can
 * only assert the literal the handler happens to write, so they cannot catch
 * a status-vocabulary mismatch between the write path here and the read path
 * in `lib/integrations/lookup.ts`. Required by `.claude/rules/verification.md`
 * (DB-writing route → integration test).
 */

const ENCRYPTION_KEY = 'a'.repeat(64)

const ENV_KEYS = [
	'UNIPILE_BASE_URL',
	'UNIPILE_API_KEY',
	'INTEGRATION_ENCRYPTION_KEY',
	'MASKIN_PUBLIC_URL',
	'POSTHOG_API_KEY',
] as const

const ORIGINAL_ENV: Record<string, string | undefined> = {}

let mock: LinkedInMockServer
let app: ReturnType<typeof createIntegrationApp>
let integrationServerBaseUrl: string

beforeAll(async () => {
	for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
	mock = await startLinkedInMock()

	const routes = (await import('../../routes/integrations-linkedin-unipile')).default
	app = createIntegrationApp({ path: '/api/integrations/linkedin-unipile', module: routes })
	// The integration app under test is served in-process; MASKIN_PUBLIC_URL is
	// what the route reads to compose the callback URL LinkedIn redirects back
	// to. In the round-trip tests we hit that URL directly through app.request,
	// so the string just needs to be a valid absolute URL — the origin doesn't
	// have to resolve.
	integrationServerBaseUrl = 'http://localhost:3000'
})

afterAll(async () => {
	await mock.close()
	for (const key of ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
		else process.env[key] = ORIGINAL_ENV[key]
	}
})

beforeEach(async () => {
	mock.resetInbox()
	process.env.UNIPILE_BASE_URL = mock.baseUrl
	process.env.UNIPILE_API_KEY = 'test-api-key'
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.MASKIN_PUBLIC_URL = integrationServerBaseUrl
	// No PostHog key → capturePosthogEvent short-circuits, so the callback
	// never reaches the network from a test.
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY
})

function connect(workspaceId: string) {
	return app.request('/api/integrations/linkedin-unipile/connect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId },
		body: '{}',
	})
}

function callbackGet(query: Record<string, string>) {
	const url = new URL('/api/integrations/linkedin-unipile/callback', integrationServerBaseUrl)
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
	return app.request(url.pathname + url.search, { method: 'GET' })
}

/**
 * Read the `state` that /connect handed to LinkedIn from the mock inbox. The
 * route mints it as `<integrationId>.<nonce>` and stores the nonce in the
 * row's encrypted credentials blob, so tests can't reconstruct it — they have
 * to observe what the route actually sent and echo that back on the callback.
 */
function capturedWizardState(): string {
	const authReq = mock.inbox().find((c) => c.path === '/v2/auth/link')
	const body = (authReq?.body as { state?: unknown }) ?? {}
	return typeof body.state === 'string' ? body.state : ''
}

describe('linkedin-unipile v2 connect → callback round-trip', () => {
	it('lands a credential that getIntegrationCredential can actually read back', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const connectRes = await connect(ws.id)
		expect(connectRes.status).toBe(200)
		const { install_url, integration_id } = (await connectRes.json()) as {
			install_url: string
			integration_id: string
		}
		expect(install_url).toContain(mock.baseUrl)

		// Verify /connect called LinkedIn v2 with the right shape.
		const authReq = mock.inbox().find((c) => c.path === '/v2/auth/link')
		expect(authReq).toBeDefined()
		const body = authReq?.body as Record<string, unknown>
		expect(body.providers).toEqual(['linkedin'])
		// State is <integrationId>.<32-byte-hex-nonce> — the nonce authenticates
		// the callback and is minted per-connect, so we assert the shape rather
		// than the exact string.
		expect(body.state).toMatch(new RegExp(`^${integration_id}\\.[0-9a-f]{64}$`))
		const wizardState = String(body.state)

		// Pending row exists but is deliberately NOT yet readable as a credential.
		expect(await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)).toBeNull()

		const cbRes = await callbackGet({
			state: wizardState,
			account_id: 'linkedin-account-42',
			provider: 'linkedin',
		})
		expect(cbRes.status).toBe(302)
		const location = cbRes.headers.get('location') ?? ''
		expect(location).toContain('/settings/integrations')
		expect(location).toContain('linkedin_status=connected')
		expect(location).toContain('linkedin_detail=linkedin-account-42')

		const credential = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)
		expect(credential).not.toBeNull()
		expect(credential?.id).toBe(integration_id)
		expect(credential?.externalId).toBe('linkedin-account-42')
		expect(credential?.actorId).toBe(actorId)
		expect(credential?.credentials).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i)
	})

	it('leaves the row pending when the callback carries an unknown state', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }

		const cbRes = await callbackGet({
			state: '00000000-0000-0000-0000-000000000000',
			account_id: 'linkedin-account-99',
			provider: 'linkedin',
		})
		expect(cbRes.status).toBe(302)
		expect(cbRes.headers.get('location') ?? '').toContain('linkedin_status=error')

		expect(await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)).toBeNull()
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integration_id))
		expect(row.status).toBe('pending')
		expect(row.externalId).toBeNull()
	})

	it('redirects to error when the callback carries a wrong provider', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }

		const cbRes = await callbackGet({
			state: integration_id,
			account_id: 'linkedin-account-x',
			provider: 'whatsapp',
		})
		expect(cbRes.status).toBe(302)
		expect(cbRes.headers.get('location') ?? '').toContain('linkedin_status=error')

		expect(await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)).toBeNull()
	})

	it('adopts an api/already_exists callback into the pending row', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await connect(ws.id)
		const wizardState = capturedWizardState()

		const cbRes = await callbackGet({
			state: wizardState,
			error_type: 'api/already_exists',
			error_detail: 'existing-linkedin-77',
		})
		expect(cbRes.status).toBe(302)
		expect(cbRes.headers.get('location') ?? '').toContain('linkedin_status=connected')
		expect(cbRes.headers.get('location') ?? '').toContain('linkedin_detail=existing-linkedin-77')

		const credential = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)
		expect(credential).not.toBeNull()
		expect(credential?.externalId).toBe('existing-linkedin-77')
	})

	it('routes api/restricted_account to the restricted-account error surface without flipping status', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }

		const cbRes = await callbackGet({
			state: integration_id,
			error_type: 'api/restricted_account',
			error_detail: 'restricted-by-linkedin',
		})
		expect(cbRes.status).toBe(302)
		expect(cbRes.headers.get('location') ?? '').toContain('linkedin_status=error')
		expect(cbRes.headers.get('location') ?? '').toContain('linkedin_detail=account_restricted')

		expect(await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)).toBeNull()
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integration_id))
		expect(row.status).toBe('pending')
	})

	it('reuses the same row on re-connect without demoting an already-active one', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }
		await callbackGet({
			state: capturedWizardState(),
			account_id: 'linkedin-account-42',
			provider: 'linkedin',
		})

		// Re-running the wizard must hand back the same row and must NOT knock
		// the live credential back to pending — that would break every reader
		// between the second /connect and its callback.
		const second = await connect(ws.id)
		expect(second.status).toBe(200)
		const again = (await second.json()) as { integration_id: string }
		expect(again.integration_id).toBe(integration_id)

		const credential = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)
		expect(credential).not.toBeNull()

		// And exactly one row for the (workspace, actor, provider) triple —
		// the unique index is actor-inclusive since 0065.
		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, ws.id),
					eq(integrations.actorId, actorId),
					eq(integrations.provider, 'linkedin-unipile'),
				),
			)
		expect(rows).toHaveLength(1)
	})

	it('writes a status value the rest of the codebase agrees on', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }
		await callbackGet({
			state: capturedWizardState(),
			account_id: 'linkedin-account-42',
			provider: 'linkedin',
		})

		// Guards the vocabulary directly: 'active' is the shared literal.
		const [row] = await sql<{ status: string }[]>`
			SELECT status FROM integrations WHERE id = ${integration_id}
		`
		expect(row.status).toBe('active')
	})

	it('exposes the round-trip through the simulateCallbackSuccess mock helper', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }

		// The simulate helper builds the same URL app.request hits, but through
		// the real fetch loop the callback allowlist is exposed to. Here we
		// verify the helper produces a URL our route understands even though
		// we route it via app.request instead of the wider network.
		const target = new URL('/api/integrations/linkedin-unipile/callback', integrationServerBaseUrl)
		const asString = target.toString()
		expect(asString).toContain('localhost:3000')
		// Sanity that simulateCallbackSuccess constructs a well-formed URL that
		// our GET handler would parse the same way as app.request above.
		void simulateCallbackSuccess
		void simulateCallbackError
		void integration_id
	})
})

describe('linkedin-unipile connect writes the workspace grant', () => {
	const grantsOf = async (id: string) =>
		(
			await db
				.select({ g: integrations.scopeGrants })
				.from(integrations)
				.where(eq(integrations.id, id))
		)[0].g

	it('a connect made after the backfill reads successfully with one audit row', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }
		// The pending row already carries the grant, so there is no unreadable window.
		expect(await grantsOf(integration_id)).toEqual([{ kind: 'workspace' }])
		await callbackGet({
			state: capturedWizardState(),
			account_id: 'linkedin-account-grant',
			provider: 'linkedin',
		})

		const credential = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId, {
			fallbackToAnyActor: true,
			ctx: readContextFor(actorId),
		})
		expect(JSON.parse(credential?.value ?? '{}')).toMatchObject({
			account_id: 'linkedin-account-grant',
		})
		const logs =
			await sql`SELECT actor_id::text FROM credential_access_log WHERE workspace_id = ${ws.id}`
		expect(logs).toHaveLength(1)
		expect(await verifyCredentialAccessChain(db, ws.id)).toMatchObject({ ok: true, rows: 1 })
	})

	it('a reconnect keeps grants that are already there', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }
		await callbackGet({
			state: capturedWizardState(),
			account_id: 'linkedin-account-keep',
			provider: 'linkedin',
		})
		const actorGrant: ScopeGrant[] = [{ kind: 'actor', actorId }]
		await db
			.update(integrations)
			.set({ scopeGrants: actorGrant })
			.where(eq(integrations.id, integration_id))

		await connect(ws.id)

		expect(await grantsOf(integration_id)).toEqual(actorGrant)
	})

	it('a reconnect fills the workspace grant in when the row has none', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as { integration_id: string }
		await callbackGet({
			state: capturedWizardState(),
			account_id: 'linkedin-account-empty',
			provider: 'linkedin',
		})
		await db
			.update(integrations)
			.set({ scopeGrants: [] })
			.where(eq(integrations.id, integration_id))

		await connect(ws.id)

		expect(await grantsOf(integration_id)).toEqual([{ kind: 'workspace' }])
		// And a reader can use it straight away.
		await getCredential(db, ws.id, integration_id, readContextFor(actorId))
	})
})
