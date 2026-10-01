import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * R11-C · POST /api/integrations/linkedin-unipile/webhook route coverage.
 *
 * The verifier itself is unit-tested in
 * `apps/dev/src/__tests__/lib/integrations/providers/linkedin-unipile-webhook-signature.test.ts`;
 * this suite pins the route's contract on top of it:
 *
 *   1. Missing `UNIPILE_WEBHOOK_SECRET` env var → 500.
 *   2. Missing / invalid `unipile-signature` header → 401 (no side effects).
 *   3. Unhandled event kind → 200 with `{ skipped: true }` (no re-enumeration).
 *   4. `account.reconnect` with a valid signature → invokes the webhook client
 *      builder and calls `handleUnipileAccountReconnect` with the payload's
 *      `account_id`.
 *   5. Body tamper (signature computed over one body, request sent with
 *      another) → 401.
 */

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// `vi.mock` factories run at hoist time (before any top-level `const`
// declaration in this file resolves), so the sentinel + spy must be created
// inside `vi.hoisted` and read from the same handle in both the mock body
// AND the assertions below. A plain top-level `const` used inside the
// factory throws "Cannot access X before initialization" at hoist time.
const mocks = vi.hoisted(() => ({
	webhookClientSentinel: { __sentinel: 'webhook-client' } as const,
	handleUnipileAccountReconnect: vi.fn(),
}))

vi.mock('../../lib/integrations/providers/linkedin-unipile/webhook', () => ({
	buildLinkedInClientForWebhook: () => mocks.webhookClientSentinel,
	handleUnipileAccountReconnect: mocks.handleUnipileAccountReconnect,
}))

import integrationsLinkedinRoutes from '../integrations-linkedin-unipile'

const SECRET = 'wes_01testendpointsecret'
const ROUTE = 'http://localhost/api/integrations/linkedin-unipile/webhook'

function buildApp(): Hono {
	const app = new Hono()
	app.use('*', async (c, next) => {
		// The webhook route reads `db` from context but our mock of
		// `handleUnipileAccountReconnect` ignores it — a sentinel is enough.
		c.set('db' as never, { __sentinel: 'db' } as unknown)
		await next()
	})
	app.route('/api/integrations/linkedin-unipile', integrationsLinkedinRoutes)
	return app
}

function sign(rawBody: string, secret: string = SECRET, tSec?: number): string {
	const t = tSec ?? Math.floor(Date.now() / 1000)
	const v0 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
	return `t=${t},v0=${v0}`
}

// Snapshot the original UNIPILE_WEBHOOK_SECRET on suite load so the
// per-test manipulation can be restored via property re-assign rather
// than `delete`, which biome's `noDelete` rule flags.
const ORIGINAL_SECRET = process.env.UNIPILE_WEBHOOK_SECRET

function unsetWebhookSecret(): void {
	// `Reflect.deleteProperty` reproduces the semantics `delete` would have
	// (the key is fully removed from `process.env`, not set to the string
	// "undefined") without tripping the lint rule.
	Reflect.deleteProperty(process.env, 'UNIPILE_WEBHOOK_SECRET')
}

beforeEach(() => {
	process.env.UNIPILE_WEBHOOK_SECRET = SECRET
	mocks.handleUnipileAccountReconnect.mockReset()
	mocks.handleUnipileAccountReconnect.mockResolvedValue({ appliedTo: [] })
})

afterEach(() => {
	if (ORIGINAL_SECRET === undefined) unsetWebhookSecret()
	else process.env.UNIPILE_WEBHOOK_SECRET = ORIGINAL_SECRET
})

describe('POST /api/integrations/linkedin-unipile/webhook — auth', () => {
	it('returns 500 when UNIPILE_WEBHOOK_SECRET is not configured', async () => {
		unsetWebhookSecret()
		const app = buildApp()
		const body = '{"type":"account.reconnect","account_id":"acc_1"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: { 'unipile-signature': sign(body, SECRET), 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(500)
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})

	it('returns 401 when the signature header is absent', async () => {
		const app = buildApp()
		const body = '{"type":"account.reconnect","account_id":"acc_1"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(401)
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})

	it('returns 401 when the signature is over a different body (tamper detection)', async () => {
		const app = buildApp()
		const signedFor = '{"type":"account.reconnect","account_id":"acc_ORIGINAL"}'
		const actual = '{"type":"account.reconnect","account_id":"acc_ATTACKER"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: {
				'unipile-signature': sign(signedFor, SECRET),
				'content-type': 'application/json',
			},
			body: actual,
		})
		expect(res.status).toBe(401)
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})

	it('returns 401 when the signature was computed with a different secret', async () => {
		const app = buildApp()
		const body = '{"type":"account.reconnect","account_id":"acc_1"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: {
				'unipile-signature': sign(body, 'wes_wrongsecret'),
				'content-type': 'application/json',
			},
			body,
		})
		expect(res.status).toBe(401)
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})
})

describe('POST /api/integrations/linkedin-unipile/webhook — event handling', () => {
	it('acknowledges (200 skipped) unhandled event kinds without re-enumerating', async () => {
		const app = buildApp()
		const body = '{"type":"message.new","account_id":"acc_1"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: { 'unipile-signature': sign(body, SECRET), 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(200)
		const json = (await res.json()) as { ok: boolean; skipped?: boolean }
		expect(json.ok).toBe(true)
		expect(json.skipped).toBe(true)
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})

	it('acknowledges (200 skipped) a payload missing account_id', async () => {
		const app = buildApp()
		const body = '{"type":"account.reconnect"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: { 'unipile-signature': sign(body, SECRET), 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: true })
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})

	it('rejects the legacy `account.updated` event as unhandled (v2 does not emit it)', async () => {
		// Regression pin: the v1 spelling would have quietly been treated as a
		// re-enumeration event before R11-C reconciled with the v2 event catalog.
		const app = buildApp()
		const body = '{"type":"account.updated","account_id":"acc_1"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: { 'unipile-signature': sign(body, SECRET), 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, skipped: true })
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})

	it('re-enumerates on account.reconnect with a valid signature', async () => {
		const app = buildApp()
		mocks.handleUnipileAccountReconnect.mockResolvedValueOnce({
			appliedTo: [{ integrationId: 'int-1', workspaceId: 'ws-1', diff: { unchanged: [] } }],
		})
		const body = '{"type":"account.reconnect","account_id":"acc_target"}'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: { 'unipile-signature': sign(body, SECRET), 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(200)
		expect(mocks.handleUnipileAccountReconnect).toHaveBeenCalledTimes(1)
		const args = mocks.handleUnipileAccountReconnect.mock.calls[0]
		// [db, client, accountId]
		expect(args?.[1]).toBe(mocks.webhookClientSentinel)
		expect(args?.[2]).toBe('acc_target')
	})

	it('returns 400 on a body that is not valid JSON (after the signature checks out)', async () => {
		const app = buildApp()
		const body = 'not-json'
		const res = await app.request(ROUTE, {
			method: 'POST',
			headers: { 'unipile-signature': sign(body, SECRET), 'content-type': 'application/json' },
			body,
		})
		expect(res.status).toBe(400)
		expect(mocks.handleUnipileAccountReconnect).not.toHaveBeenCalled()
	})
})
