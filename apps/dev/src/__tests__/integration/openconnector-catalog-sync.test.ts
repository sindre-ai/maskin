import { marketplaceLoopItems, marketplaceLoops } from '@maskin/db/schema'
import { sql as dsql, eq, inArray } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncOpenConnectorCatalog } from '../../jobs/sync-openconnector-catalog'
import { db } from './global-setup'

/**
 * Exercises the catalog sync against real Postgres. The mocked-DB harness
 * cannot cover what actually matters here: the slug unique constraint driving
 * the upsert, the FK cascade from marketplace_loops to its items, and the
 * `item_snapshot->>'source'` provenance predicate reconciliation depends on.
 */

const PROVIDERS = [
	{
		id: 'stripe',
		name: 'Stripe',
		category: 'Payments',
		iconUrl: 'https://cdn.example/stripe.svg',
		description: 'Accept payments',
		actionCount: 12,
	},
	{
		id: 'notion',
		name: 'Notion',
		category: 'Productivity',
		iconUrl: null,
		description: 'Docs and wikis',
		actionCount: 8,
	},
]

function stubRuntime(providers: unknown, status = 200) {
	vi.stubEnv('OPENCONNECTOR_RUNTIME_URL', 'http://openconnector.test')
	vi.stubEnv('OPENCONNECTOR_RUNTIME_TOKEN', 'tok')
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: status >= 200 && status < 300,
			status,
			json: async () => providers,
		} as unknown as Response),
	)
}

async function catalogSlugs(): Promise<string[]> {
	const rows = await db
		.select({ slug: marketplaceLoops.slug })
		.from(marketplaceLoops)
		.innerJoin(marketplaceLoopItems, eq(marketplaceLoopItems.loopId, marketplaceLoops.id))
		.where(dsql`${marketplaceLoopItems.itemSnapshot}->>'source' = 'openconnector'`)
	return rows.map((r) => r.slug).sort()
}

async function cleanup() {
	const rows = await db
		.select({ id: marketplaceLoops.id })
		.from(marketplaceLoops)
		.innerJoin(marketplaceLoopItems, eq(marketplaceLoopItems.loopId, marketplaceLoops.id))
		.where(dsql`${marketplaceLoopItems.itemSnapshot}->>'source' = 'openconnector'`)
	if (rows.length > 0) {
		await db.delete(marketplaceLoops).where(
			inArray(
				marketplaceLoops.id,
				rows.map((r) => r.id),
			),
		)
	}
}

describe('syncOpenConnectorCatalog', () => {
	afterEach(async () => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		await cleanup()
	})

	it('writes one single-type loop with one integration item per provider', async () => {
		stubRuntime(PROVIDERS)
		await syncOpenConnectorCatalog(db)

		expect(await catalogSlugs()).toEqual(['integration-notion', 'integration-stripe'])

		const [loop] = await db
			.select()
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.slug, 'integration-stripe'))
		expect(loop?.name).toBe('Stripe')
		// Category rides on use_case, which is what drives the marketplace's
		// category filter chips.
		expect(loop?.useCase).toBe('Payments')

		const items = await db
			.select()
			.from(marketplaceLoopItems)
			.where(eq(marketplaceLoopItems.loopId, loop?.id as string))
		expect(items).toHaveLength(1)
		expect(items[0]?.itemType).toBe('integration')
		const snapshot = items[0]?.itemSnapshot as Record<string, unknown>
		// `provider` is what buildIntegrationInsert() keys the install on.
		expect(snapshot.provider).toBe('stripe')
		expect(snapshot.icon_url).toBe('https://cdn.example/stripe.svg')
	})

	it('is idempotent — a second sync updates in place rather than duplicating', async () => {
		stubRuntime(PROVIDERS)
		await syncOpenConnectorCatalog(db)
		await syncOpenConnectorCatalog(db)

		expect(await catalogSlugs()).toEqual(['integration-notion', 'integration-stripe'])

		const [loop] = await db
			.select()
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.slug, 'integration-stripe'))
		const items = await db
			.select()
			.from(marketplaceLoopItems)
			.where(eq(marketplaceLoopItems.loopId, loop?.id as string))
		expect(items).toHaveLength(1)
	})

	it('updates a renamed provider on the existing row', async () => {
		stubRuntime(PROVIDERS)
		await syncOpenConnectorCatalog(db)
		stubRuntime([{ ...PROVIDERS[0], name: 'Stripe Payments', description: 'Now renamed' }])
		await syncOpenConnectorCatalog(db)

		const [loop] = await db
			.select()
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.slug, 'integration-stripe'))
		expect(loop?.name).toBe('Stripe Payments')
		expect(loop?.description).toBe('Now renamed')
	})

	it('removes providers the runtime no longer lists, cascading their items', async () => {
		stubRuntime(PROVIDERS)
		await syncOpenConnectorCatalog(db)
		const [gone] = await db
			.select({ id: marketplaceLoops.id })
			.from(marketplaceLoops)
			.where(eq(marketplaceLoops.slug, 'integration-notion'))

		stubRuntime([PROVIDERS[0]])
		await syncOpenConnectorCatalog(db)

		expect(await catalogSlugs()).toEqual(['integration-stripe'])
		const orphans = await db
			.select()
			.from(marketplaceLoopItems)
			.where(eq(marketplaceLoopItems.loopId, gone?.id as string))
		expect(orphans).toHaveLength(0)
	})

	it('leaves the catalog standing when the runtime is unreachable', async () => {
		stubRuntime(PROVIDERS)
		await syncOpenConnectorCatalog(db)
		stubRuntime({}, 503)
		await syncOpenConnectorCatalog(db)
		expect(await catalogSlugs()).toEqual(['integration-notion', 'integration-stripe'])
	})

	it('writes nothing and does not throw when the runtime is unconfigured', async () => {
		vi.stubEnv('OPENCONNECTOR_RUNTIME_URL', '')
		vi.stubEnv('OPENCONNECTOR_RUNTIME_TOKEN', '')
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		await expect(syncOpenConnectorCatalog(db)).resolves.toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await catalogSlugs()).toEqual([])
	})
})
