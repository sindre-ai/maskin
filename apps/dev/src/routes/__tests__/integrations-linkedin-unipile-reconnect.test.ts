import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P3-H · Reconnect reuses the existing Unipile account.
 *
 * Two branches this file pins:
 *
 *   1. `/connect` on a row with an existing `external_id` requests a
 *      RECONNECT hosted-auth link (Unipile v2's `{ account_id, expires_on,
 *      redirect_uri, state }` body shape) rather than a fresh `{ providers,
 *      ... }` — closing the account-churn half of insight (3) at the source
 *      per the task's amendment.
 *
 *   2. `/callback` on a reconnect where Unipile returned the SAME account_id
 *      leaves `integrations.external_id` unchanged and does NOT fire a
 *      deleteAccount call. `/callback` on a reconnect where Unipile returned
 *      a DIFFERENT account_id delegates orphan cleanup to
 *      `deleteUnipileAccountForReconnectOrphan` — best-effort DELETE against
 *      the prior id — and emits a warn log naming both ids.
 *
 * Uses the same in-process Unipile mock as the P3-B disconnect suite so the
 * exact wire path (`DELETE /v2/accounts/{account_id}` for the orphan clean-
 * up; `POST /v2/auth/link` for the connect body) is exercised end-to-end.
 * The mock rejects a `/v2/auth/link` body carrying BOTH `providers` and
 * `account_id` with the same 400 the live Unipile v2 API returns (schema is
 * `anyOf`); that's what stops a client-side regression that co-sends both
 * fields from passing a suite while breaking against production.
 */

// vi.mock hoists — register these BEFORE any module import.
vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn((s: string) => s),
	encrypt: vi.fn((s: string) => s),
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: vi.fn().mockResolvedValue(true),
}))

// Structured warn log lines are load-bearing: the "reconnect returned a
// different account_id" line is what makes the pathological branch visible
// in Sentry. Capture the calls so the assertions can pin the shape.
const logCalls = {
	info: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
	warn: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
	error: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
}
vi.mock('../../lib/logger', () => ({
	logger: {
		info: (msg: string, ctx: Record<string, unknown> = {}) => {
			logCalls.info.push({ msg, ctx })
		},
		warn: (msg: string, ctx: Record<string, unknown> = {}) => {
			logCalls.warn.push({ msg, ctx })
		},
		error: (msg: string, ctx: Record<string, unknown> = {}) => {
			logCalls.error.push({ msg, ctx })
		},
		debug: vi.fn(),
	},
}))

vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/linkedin-addon-billing', () => ({
	startLinkedInAddonCheckout: vi.fn().mockResolvedValue(null),
	syncLinkedInAddonQuantity: vi.fn().mockResolvedValue({ status: 'ok' as const }),
}))

// Route imports the real enumeration path but we want the fixture from the
// fan-out helper (1 personal + 2 pages) rather than hitting a live LinkedIn.
// Same pattern the fan-out suite uses.
vi.mock('../../lib/integrations/providers/linkedin-unipile/enumeration', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/linkedin-unipile/enumeration')
	>('../../lib/integrations/providers/linkedin-unipile/enumeration')
	const { fakeLinkedInClientForTests } = await import('./__helpers/fake-linkedin-client')
	return {
		...actual,
		enumerateLinkedInIdentitiesAndRegister: (
			params: Parameters<typeof actual.enumerateLinkedInIdentitiesAndRegister>[0],
		) =>
			actual.enumerateLinkedInIdentitiesAndRegister(params, {
				client: fakeLinkedInClientForTests(),
			}),
	}
})

import {
	type LinkedInMockServer,
	startLinkedInMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { __setLinkedInDisconnectClientForTests } from '../../lib/integrations/providers/linkedin-unipile/disconnect'
import { createLinkedInHttpClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import integrationsLinkedinRoutes from '../integrations-linkedin-unipile'

interface IntegrationRow {
	id: string
	workspaceId: string
	actorId: string | null
	createdBy: string
	provider: string
	status: string
	credentials: string
	externalId: string | null
	unipileAccSlug: string | null
	updatedAt: Date
}

/**
 * Fake DB satisfying the route's SELECT / UPDATE / INSERT / transaction
 * shape. Narrow on purpose — matches the fan-out suite's helper so a schema
 * regression is spotted in one place, not five.
 */
function buildFakeDb(initial: IntegrationRow[] = []) {
	const rows: IntegrationRow[] = [...initial]
	const events: unknown[] = []
	const select = vi.fn(() => ({
		from: () => ({
			where: () => ({
				limit: async () => rows.slice(0, 1),
			}),
		}),
	}))
	const update = vi.fn(() => ({
		set: (patch: Partial<IntegrationRow>) => ({
			where: async () => {
				if (rows[0]) Object.assign(rows[0], patch)
			},
		}),
	}))
	const insert = vi.fn(() => ({
		values: async (v: unknown) => {
			events.push(v)
		},
	}))
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
		await fn({ select, update, insert })
	})
	return {
		db: { select, insert, update, transaction, delete: vi.fn() } as unknown as never,
		rows,
		events,
	}
}

const INTEGRATION_ID = 'a4f0a13d-ce36-4bcc-b9c5-ecc9512f31e2'
const WORKSPACE_ID = '77777777-7777-4777-8777-777777777777'
const ACTOR_ID = '88888888-8888-4888-8888-888888888888'
const PRIOR_ACCOUNT_ID = 'acc_01m204k0priorreconnect'
const NEW_ACCOUNT_ID = 'acc_01m2abxfnewreconnect'
const NONCE = 'c'.repeat(64)

function reconnectableRow(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
	return {
		id: INTEGRATION_ID,
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		createdBy: ACTOR_ID,
		provider: 'linkedin-unipile',
		// Reconnect starts from an already-active row; the nonce mint in
		// `/connect` deliberately does NOT demote status to `pending` when the
		// row is `active`, per the connect handler's inline comment. The row
		// carries `externalId` — that's the load-bearing signal that this row
		// has been connected before.
		status: 'active',
		credentials: JSON.stringify({
			account_id: PRIOR_ACCOUNT_ID,
			auth_nonce: NONCE,
			nonce_expires_at: new Date(Date.now() + 60_000).toISOString(),
		}),
		externalId: PRIOR_ACCOUNT_ID,
		unipileAccSlug: 'sebastianbille',
		updatedAt: new Date(),
		...overrides,
	}
}

function buildApp(db: unknown) {
	const app = new Hono<{ Variables: { db: unknown; actorId: string } }>()
	app.use('*', async (c, next) => {
		c.set('db', db as never)
		c.set('actorId', ACTOR_ID)
		await next()
	})
	app.route('/api/integrations/linkedin-unipile', integrationsLinkedinRoutes)
	return app
}

describe('P3-H · /connect requests a reconnect link when the row has an existing external_id', () => {
	let mock: LinkedInMockServer

	beforeEach(async () => {
		mock = await startLinkedInMock()
		process.env.UNIPILE_BASE_URL = mock.baseUrl
		process.env.UNIPILE_API_KEY = 'test-api-key'
		process.env.MASKIN_PUBLIC_URL = 'http://localhost:3000'
		logCalls.info.length = 0
		logCalls.warn.length = 0
		logCalls.error.length = 0
	})

	afterEach(async () => {
		await mock.close()
	})

	it('POSTs /v2/auth/link with { account_id: priorExternalId } and NO providers', async () => {
		const { db } = buildFakeDb([reconnectableRow()])
		const app = buildApp(db)
		app.use('*', async (c, next) => {
			c.req.raw.headers.set('x-workspace-id', WORKSPACE_ID)
			await next()
		})

		const res = await app.request('/api/integrations/linkedin-unipile/connect', {
			method: 'POST',
			headers: { 'x-workspace-id': WORKSPACE_ID },
		})
		expect(res.status).toBe(200)

		const authLinkCall = mock.inbox().find((c) => c.path === '/v2/auth/link')
		expect(authLinkCall).toBeDefined()
		const body = authLinkCall?.body as Record<string, unknown>
		expect(body.account_id).toBe(PRIOR_ACCOUNT_ID)
		// The mock returns 400 if both fields are present. This assertion is
		// what stops a client regression that co-sends both fields from
		// silently passing.
		expect('providers' in body).toBe(false)
	})

	it('POSTs /v2/auth/link with { providers: ["linkedin"] } and NO account_id on a fresh connect (no prior external_id)', async () => {
		const { db } = buildFakeDb([reconnectableRow({ externalId: null, status: 'pending' })])
		const app = buildApp(db)
		app.use('*', async (c, next) => {
			c.req.raw.headers.set('x-workspace-id', WORKSPACE_ID)
			await next()
		})

		const res = await app.request('/api/integrations/linkedin-unipile/connect', {
			method: 'POST',
			headers: { 'x-workspace-id': WORKSPACE_ID },
		})
		expect(res.status).toBe(200)

		const authLinkCall = mock.inbox().find((c) => c.path === '/v2/auth/link')
		expect(authLinkCall).toBeDefined()
		const body = authLinkCall?.body as Record<string, unknown>
		expect(body.providers).toEqual(['linkedin'])
		expect('account_id' in body).toBe(false)
	})

	// Regression: connect → disconnect → connect for the same (workspace,
	// actor). The disconnect hook (P3-B) deletes the Unipile account upstream
	// and flips the row's status to 'revoked' but leaves external_id in place
	// as an audit trail. A subsequent /connect must NOT reuse that stale id —
	// Unipile's hosted-auth page 404s with "Account not found. The account
	// you try to reconnect does not exist." Fresh-mint instead.
	it('POSTs /v2/auth/link with { providers: ["linkedin"] } when the prior row is revoked (connect → disconnect → connect)', async () => {
		const { db } = buildFakeDb([reconnectableRow({ status: 'revoked' })])
		const app = buildApp(db)
		app.use('*', async (c, next) => {
			c.req.raw.headers.set('x-workspace-id', WORKSPACE_ID)
			await next()
		})

		const res = await app.request('/api/integrations/linkedin-unipile/connect', {
			method: 'POST',
			headers: { 'x-workspace-id': WORKSPACE_ID },
		})
		expect(res.status).toBe(200)

		const authLinkCall = mock.inbox().find((c) => c.path === '/v2/auth/link')
		expect(authLinkCall).toBeDefined()
		const body = authLinkCall?.body as Record<string, unknown>
		expect(body.providers).toEqual(['linkedin'])
		expect('account_id' in body).toBe(false)
	})
})

describe('P3-H · /callback on a reconnect', () => {
	let mock: LinkedInMockServer

	beforeEach(async () => {
		mock = await startLinkedInMock()
		process.env.UNIPILE_BASE_URL = mock.baseUrl
		process.env.UNIPILE_API_KEY = 'test-api-key'
		process.env.MASKIN_PUBLIC_URL = 'http://localhost:3000'
		// Reconnect-orphan cleanup builds its Unipile client through the same
		// test seam as the disconnect hook (per disconnect.ts). Point that
		// builder at this suite's mock so the orphan-branch DELETE calls land
		// in the inbox we're asserting on.
		__setLinkedInDisconnectClientForTests(() =>
			createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
		)
		logCalls.info.length = 0
		logCalls.warn.length = 0
		logCalls.error.length = 0
	})

	afterEach(async () => {
		await mock.close()
		__setLinkedInDisconnectClientForTests(null)
	})

	function runCallback(returnedAccountId: string) {
		const { db, rows } = buildFakeDb([reconnectableRow()])
		const app = buildApp(db)
		const url = new URL('http://x/api/integrations/linkedin-unipile/callback')
		url.searchParams.set('state', `${INTEGRATION_ID}.${NONCE}`)
		url.searchParams.set('account_id', returnedAccountId)
		url.searchParams.set('provider', 'linkedin')
		return { rows, response: app.request(url.toString(), { method: 'GET' }) }
	}

	it('same account_id round-trip → external_id unchanged, no DELETE, no reconnect-orphan warn log', async () => {
		const { rows, response } = runCallback(PRIOR_ACCOUNT_ID)
		const res = await response
		expect(res.status).toBe(302)
		// Row still points at the prior (== new) account id.
		expect(rows[0]?.externalId).toBe(PRIOR_ACCOUNT_ID)

		const deletes = mock.inbox().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(0)
		const differentIdWarn = logCalls.warn.find((l) =>
			l.msg.includes('reconnect returned a different account_id'),
		)
		expect(differentIdWarn).toBeUndefined()
	})

	it('different account_id → warn log + best-effort DELETE against the PRIOR id, new id lands', async () => {
		const { rows, response } = runCallback(NEW_ACCOUNT_ID)
		const res = await response
		expect(res.status).toBe(302)
		// Row now points at the freshly minted id.
		expect(rows[0]?.externalId).toBe(NEW_ACCOUNT_ID)

		// One DELETE, and it targets the ORPHANED (prior) id — deleting the
		// new one would defeat the purpose (and would immediately break the
		// row that just landed).
		const deletes = mock.inbox().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toBe(`/v2/accounts/${PRIOR_ACCOUNT_ID}`)

		const differentIdWarn = logCalls.warn.find((l) =>
			l.msg.includes('reconnect returned a different account_id'),
		)
		expect(differentIdWarn).toBeDefined()
		expect(differentIdWarn?.ctx.prior_external_id).toBe(PRIOR_ACCOUNT_ID)
		expect(differentIdWarn?.ctx.new_external_id).toBe(NEW_ACCOUNT_ID)

		// The `deleteUnipileAccountBestEffort` call emits an info-level
		// "deleted upstream" log tagged reason: 'reconnect-orphan'. This is
		// what proves the shared helper (P3-B) is being reused rather than a
		// second implementation.
		const deletedLog = logCalls.info.find(
			(l) =>
				l.msg.includes('deleteAccount: deleted upstream') && l.ctx.reason === 'reconnect-orphan',
		)
		expect(deletedLog).toBeDefined()
		expect(deletedLog?.ctx.accountId).toBe(PRIOR_ACCOUNT_ID)
	})

	it('different account_id + Unipile DELETE returns 404 → local landing still commits, log-and-continue', async () => {
		mock.setNext('delete-account-already-gone')

		const { rows, response } = runCallback(NEW_ACCOUNT_ID)
		const res = await response
		expect(res.status).toBe(302)
		// Local landing still happened — the whole contract of best-effort
		// is that a Unipile hiccup on the orphan delete NEVER blocks the
		// user's reconnect.
		expect(rows[0]?.externalId).toBe(NEW_ACCOUNT_ID)

		const alreadyGone = logCalls.info.find(
			(l) => l.msg.includes('already gone upstream') && l.ctx.reason === 'reconnect-orphan',
		)
		expect(alreadyGone).toBeDefined()
		expect(alreadyGone?.ctx.accountId).toBe(PRIOR_ACCOUNT_ID)
	})

	it('different account_id + Unipile DELETE returns 503 → local landing still commits, non-404 warn log', async () => {
		mock.setNext('delete-account-unavailable')

		const { rows, response } = runCallback(NEW_ACCOUNT_ID)
		const res = await response
		expect(res.status).toBe(302)
		expect(rows[0]?.externalId).toBe(NEW_ACCOUNT_ID)

		const upstreamError = logCalls.warn.find(
			(l) => l.msg.includes('deleteAccount: upstream error') && l.ctx.reason === 'reconnect-orphan',
		)
		expect(upstreamError).toBeDefined()
		expect(upstreamError?.ctx.status).toBe(503)
		expect(upstreamError?.ctx.accountId).toBe(PRIOR_ACCOUNT_ID)
	})
})
