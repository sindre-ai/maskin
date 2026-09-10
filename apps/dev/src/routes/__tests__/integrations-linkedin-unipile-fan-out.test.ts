import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * R11-A · integrations-linkedin-unipile-fan-out.test.ts — the connect-callback
 * enumeration path against a fixture with 1 personal + 2 admined pages (one
 * messaging-enabled, one publish-only). Named in the R11-A acceptance
 * criteria list.
 *
 * The two branches this file has to prove:
 *   - After `/callback` resolves the state successfully, one MCP instance
 *     lands per identity (personal + every admined page) via
 *     `registerLinkedInMcpInstance`.
 *   - `integrations.unipile_acc_slug` is populated with
 *     `linkedin_get_profile(me).public_identifier` in the same DB write
 *     that flips status to `active`.
 *
 * Deliberately does NOT re-verify the §2 filter table — that's the
 * fan-out-shape suite's job. This file's scope is the callback wiring.
 */

// Replace the default Unipile-client builder in the enumeration module with
// the R11-A fixture. `vi.mock` is hoisted, so this runs before the route
// import binds `enumerateLinkedInIdentitiesAndRegister`. We call through to
// the real enumeration function so the registry writes are exercised.
vi.mock('../../lib/integrations/providers/linkedin-unipile/enumeration', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/linkedin-unipile/enumeration')
	>('../../lib/integrations/providers/linkedin-unipile/enumeration')
	const { fakeLinkedInClientForTests } = await import('./__helpers/fake-linkedin-client')
	return {
		...actual,
		enumerateLinkedInIdentitiesAndRegister: (
			params: Parameters<typeof actual.enumerateLinkedInIdentitiesAndRegister>[0],
		) => actual.enumerateLinkedInIdentitiesAndRegister(params, { client: fakeLinkedInClientForTests() }),
	}
})

vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn((s: string) => s),
	encrypt: vi.fn((s: string) => s),
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/linkedin-addon-billing', () => ({
	startLinkedInAddonCheckout: vi.fn().mockResolvedValue(null),
	syncLinkedInAddonQuantity: vi.fn().mockResolvedValue({ status: 'ok' as const }),
}))

vi.mock('../../lib/integrations/providers/linkedin-unipile/client', () => ({
	createAuthLink: vi.fn().mockResolvedValue({ link: 'http://mock/wizard' }),
}))

import {
	__resetLinkedInMcpRegistryForTests,
	listLinkedInMcpInstances,
} from '@maskin/mcp/linkedin'
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
 * Fake DB that satisfies the callback path's SELECT/UPDATE/INSERT calls
 * without a real Postgres. Deliberately narrow: the callback only queries
 * `integrations` (by id) and inserts into `events` — that's it.
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

const INTEGRATION_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = 'unipile-account-abc'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const ACTOR_ID = '33333333-3333-4333-8333-333333333333'
const NONCE = 'a'.repeat(64)

function pendingRow(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
	return {
		id: INTEGRATION_ID,
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		createdBy: ACTOR_ID,
		provider: 'linkedin-unipile',
		status: 'pending',
		credentials: JSON.stringify({
			auth_nonce: NONCE,
			nonce_expires_at: new Date(Date.now() + 60_000).toISOString(),
		}),
		externalId: null,
		unipileAccSlug: null,
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

describe('linkedin-unipile connect-callback fan-out enumeration', () => {
	beforeEach(() => {
		__resetLinkedInMcpRegistryForTests()
	})

	afterEach(() => {
		__resetLinkedInMcpRegistryForTests()
	})

	it('registers 1 personal + 2 page MCP instances against the R11-A fixture (§9.2 suite 2)', async () => {
		const { db } = buildFakeDb([pendingRow()])
		const app = buildApp(db)

		const url = new URL('http://x/api/integrations/linkedin-unipile/callback')
		url.searchParams.set('state', `${INTEGRATION_ID}.${NONCE}`)
		url.searchParams.set('account_id', ACCOUNT_ID)
		url.searchParams.set('provider', 'linkedin')

		const res = await app.request(url.toString(), { method: 'GET' })
		expect(res.status).toBe(302)

		const slugs = [...listLinkedInMcpInstances().keys()].sort()
		expect(slugs).toEqual([
			'linkedin-sebastianbille-maskinio',
			'linkedin-sebastianbille-personal',
			'linkedin-sebastianbille-sample-page',
		])
		const map = listLinkedInMcpInstances()
		expect(map.get('linkedin-sebastianbille-personal')?.identityType).toBe('personal')
		expect(map.get('linkedin-sebastianbille-personal')?.messagingEnabled).toBe(true)
		expect(map.get('linkedin-sebastianbille-maskinio')?.identityType).toBe('company_page')
		expect(map.get('linkedin-sebastianbille-maskinio')?.messagingEnabled).toBe(true)
		expect(map.get('linkedin-sebastianbille-maskinio')?.mailboxId).toBe('mailbox-maskinio')
		expect(map.get('linkedin-sebastianbille-sample-page')?.identityType).toBe('company_page')
		expect(map.get('linkedin-sebastianbille-sample-page')?.messagingEnabled).toBe(false)
		expect(map.get('linkedin-sebastianbille-sample-page')?.mailboxId).toBe(null)
	})

	it('persists unipile_acc_slug on the integrations row in the same landing txn', async () => {
		const { db, rows } = buildFakeDb([pendingRow()])
		const app = buildApp(db)

		const url = new URL('http://x/api/integrations/linkedin-unipile/callback')
		url.searchParams.set('state', `${INTEGRATION_ID}.${NONCE}`)
		url.searchParams.set('account_id', ACCOUNT_ID)
		url.searchParams.set('provider', 'linkedin')
		const res = await app.request(url.toString(), { method: 'GET' })
		expect(res.status).toBe(302)

		// One row, updated in place. Slug is what R11-A's spec §1.6 requires.
		expect(rows[0]?.unipileAccSlug).toBe('sebastianbille')
		expect(rows[0]?.status).toBe('active')
		expect(rows[0]?.externalId).toBe(ACCOUNT_ID)
	})

	it('registration is idempotent across two identical connects (deterministic slug)', async () => {
		// First connect.
		{
			const { db } = buildFakeDb([pendingRow()])
			const app = buildApp(db)
			const url = new URL('http://x/api/integrations/linkedin-unipile/callback')
			url.searchParams.set('state', `${INTEGRATION_ID}.${NONCE}`)
			url.searchParams.set('account_id', ACCOUNT_ID)
			url.searchParams.set('provider', 'linkedin')
			await app.request(url.toString(), { method: 'GET' })
		}
		const firstKeys = [...listLinkedInMcpInstances().keys()].sort()
		// Second connect against the SAME account — the registry replaces the
		// prior config atomically, does not append a new one. Same instance
		// slugs must reappear.
		{
			const { db } = buildFakeDb([pendingRow()])
			const app = buildApp(db)
			const url = new URL('http://x/api/integrations/linkedin-unipile/callback')
			url.searchParams.set('state', `${INTEGRATION_ID}.${NONCE}`)
			url.searchParams.set('account_id', ACCOUNT_ID)
			url.searchParams.set('provider', 'linkedin')
			await app.request(url.toString(), { method: 'GET' })
		}
		expect([...listLinkedInMcpInstances().keys()].sort()).toEqual(firstKeys)
		expect(listLinkedInMcpInstances().size).toBe(3)
	})
})
