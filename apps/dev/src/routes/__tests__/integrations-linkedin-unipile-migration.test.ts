import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * R11-A · integrations-linkedin-unipile-migration.test.ts — spec §8 migration
 * test.
 *
 * After the connect-callback path lands the R11-A fixture (1 personal + 2
 * pages), assert two things:
 *
 *   1. The MCP registry contains EXACTLY the expected fan-out instances
 *      (three, matching `linkedin-{acc}-{identity}` for personal + each
 *      admined page).
 *   2. NONE of the registered instance names are in the retired flat
 *      `linkedin__` namespace — the migration removed that namespace end to
 *      end with no compat shim (spec §8 states there is no shim on purpose).
 *
 * This is deliberately narrow — the fan-out shape test in the mcp package
 * proves the filter and slug composers behave correctly, and the fan-out
 * route test proves the callback wiring dispatches. The migration test is
 * the acceptance-criteria-mandated end-to-end pin that the retired
 * namespace really is gone.
 */

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

import { __resetLinkedInMcpRegistryForTests, listLinkedInMcpInstances } from '@maskin/mcp/linkedin'
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

function buildFakeDb(initial: IntegrationRow[] = []) {
	const rows: IntegrationRow[] = [...initial]
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
	const insert = vi.fn(() => ({ values: async () => undefined }))
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
		await fn({ select, update, insert })
	})
	return {
		db: { select, insert, update, transaction, delete: vi.fn() } as unknown as never,
		rows,
	}
}

const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444'
const ACCOUNT_ID = 'unipile-account-abc'
const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555'
const ACTOR_ID = '66666666-6666-4666-8666-666666666666'
const NONCE = 'b'.repeat(64)

function pendingRow(): IntegrationRow {
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

async function runConnectCallback(): Promise<void> {
	const { db } = buildFakeDb([pendingRow()])
	const app = buildApp(db)
	const url = new URL('http://x/api/integrations/linkedin-unipile/callback')
	url.searchParams.set('state', `${INTEGRATION_ID}.${NONCE}`)
	url.searchParams.set('account_id', ACCOUNT_ID)
	url.searchParams.set('provider', 'linkedin')
	const res = await app.request(url.toString(), { method: 'GET' })
	expect(res.status).toBe(302)
}

describe('linkedin-unipile migration — flat linkedin__ namespace retired', () => {
	beforeEach(() => __resetLinkedInMcpRegistryForTests())
	afterEach(() => __resetLinkedInMcpRegistryForTests())

	it('after connect on the R11-A fixture, the MCP registry contains exactly the expected fan-out instances', async () => {
		await runConnectCallback()
		const slugs = [...listLinkedInMcpInstances().keys()].sort()
		expect(slugs).toEqual([
			'linkedin-sebastianbille-maskinio',
			'linkedin-sebastianbille-personal',
			'linkedin-sebastianbille-sample-page',
		])
		expect(listLinkedInMcpInstances().size).toBe(3)
	})

	it('no registered instance uses the retired flat linkedin__ namespace (spec §8, no compat shim)', async () => {
		await runConnectCallback()
		const flat = listLinkedInMcpInstances()
		for (const [slug, cfg] of flat) {
			// Every slug must follow the fan-out shape. A bare `linkedin_*`
			// (single underscore, no identity segment) or `linkedin__*` (double
			// underscore, no identity segment) is the retired flat namespace
			// leaking through — either shape must fail this assertion.
			expect(slug).toMatch(/^linkedin-[a-z0-9-]+-[a-z0-9-]+$/)
			expect(slug.startsWith('linkedin__')).toBe(false)
			expect(cfg.identitySlug).not.toBe('')
			// `linkedin_publish_business_page_post` retired without shim — the
			// registry model has no notion of a bare tool name anymore, but
			// double-check by asserting no cfg.identitySlug resolved to that
			// legacy verb name.
			expect(cfg.identitySlug).not.toMatch(/^publish_business_page_post$/)
		}
	})
})
