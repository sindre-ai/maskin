import { createHmac } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getIntegrationCredential } from '../../lib/integrations/lookup'
import {
	type UnipileMockServer,
	startUnipileMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

/**
 * Round-trip coverage for the Unipile Hosted Wizard connect flow against real
 * Postgres: POST /connect → signed POST /callback → read the credential back
 * through `getIntegrationCredential`.
 *
 * The last step is the point of this file. The mocked-DB route tests can only
 * assert the literal the handler happens to write, so they cannot catch a
 * status-vocabulary mismatch between the write path here and the read path in
 * `lib/integrations/lookup.ts` — `integrations.status` is a plain `text`
 * column with no enum or CHECK, so Postgres accepts any value and the
 * mismatch surfaces only as a credential that is silently never found.
 * Required by `.claude/rules/verification.md` (DB-writing route → integration
 * test).
 */

const WEBHOOK_SECRET = 'integration-webhook-secret'
const ENCRYPTION_KEY = 'a'.repeat(64)

const ENV_KEYS = [
	'UNIPILE_BASE_URL',
	'UNIPILE_API_KEY',
	'UNIPILE_WEBHOOK_SECRET',
	'INTEGRATION_ENCRYPTION_KEY',
	'MASKIN_PUBLIC_URL',
	'POSTHOG_API_KEY',
] as const

const ORIGINAL_ENV: Record<string, string | undefined> = {}

let mock: UnipileMockServer
let app: ReturnType<typeof createIntegrationApp>

beforeAll(async () => {
	for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
	mock = await startUnipileMock()

	const routes = (await import('../../routes/integrations-linkedin-unipile')).default
	app = createIntegrationApp({ path: '/api/integrations/linkedin-unipile', module: routes })
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
	process.env.UNIPILE_WEBHOOK_SECRET = WEBHOOK_SECRET
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.MASKIN_PUBLIC_URL = 'http://localhost:3000'
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

function signedCallback(payload: unknown) {
	const rawBody = JSON.stringify(payload)
	const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody, 'utf8').digest('hex')
	return app.request('/api/integrations/linkedin-unipile/callback', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Unipile-Signature': signature },
		body: rawBody,
	})
}

describe('linkedin-unipile connect → callback round-trip', () => {
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

		// Pending row exists but is deliberately NOT yet readable as a credential.
		expect(await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)).toBeNull()

		const cbRes = await signedCallback({
			status: 'CREATION_SUCCESS',
			account_id: 'unipile-account-42',
			name: integration_id,
		})
		expect(cbRes.status).toBe(200)

		// The assertion that matters: the row the callback wrote is findable by
		// the helper every downstream consumer uses. A status mismatch between
		// the write and this read makes it null with no error anywhere.
		const credential = await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)
		expect(credential).not.toBeNull()
		expect(credential?.id).toBe(integration_id)
		expect(credential?.externalId).toBe('unipile-account-42')
		expect(credential?.actorId).toBe(actorId)
		expect(credential?.credentials).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i)
	})

	it('leaves the row unreadable when the wizard reports a non-success status', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const { integration_id } = (await (await connect(ws.id)).json()) as {
			integration_id: string
		}

		const cbRes = await signedCallback({
			status: 'CREATION_FAILED',
			account_id: 'unipile-account-99',
			name: integration_id,
		})
		expect(cbRes.status).toBe(200)

		expect(await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)).toBeNull()
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integration_id))
		expect(row.status).toBe('pending')
		expect(row.externalId).toBeNull()
	})

	it('rejects a callback whose signature does not match the body', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const { integration_id } = (await (await connect(ws.id)).json()) as {
			integration_id: string
		}

		const res = await app.request('/api/integrations/linkedin-unipile/callback', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Unipile-Signature': 'deadbeef' },
			body: JSON.stringify({
				status: 'CREATION_SUCCESS',
				account_id: 'unipile-account-forged',
				name: integration_id,
			}),
		})
		expect(res.status).toBe(401)
		expect(await getIntegrationCredential(db, ws.id, 'linkedin-unipile', actorId)).toBeNull()
	})

	it('reuses the same row on re-connect without demoting an already-active one', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const { integration_id } = (await (await connect(ws.id)).json()) as {
			integration_id: string
		}
		await signedCallback({
			status: 'CREATION_SUCCESS',
			account_id: 'unipile-account-42',
			name: integration_id,
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
		const { integration_id } = (await (await connect(ws.id)).json()) as {
			integration_id: string
		}
		await signedCallback({
			status: 'CREATION_SUCCESS',
			account_id: 'unipile-account-42',
			name: integration_id,
		})

		// Guards the vocabulary directly, not just via the helper: 'connected'
		// is not a status any reader in this codebase recognises.
		const [row] = await sql<{ status: string }[]>`
			SELECT status FROM integrations WHERE id = ${integration_id}
		`
		expect(row.status).toBe('active')
	})
})
