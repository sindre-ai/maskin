import { toolBrokerCatalog } from '@maskin/db'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	CatalogCollapseError,
	CatalogNormalisationError,
	syncCatalog,
} from '../../lib/tool-broker/catalog-sync'
import { db } from './global-setup'

// Real Postgres, because the constraints doing the work here are database
// constraints — a mocked client accepts anything, including the icon URL this
// table exists to refuse.

const entry = (overrides: Record<string, unknown> = {}) => ({
	name: 'Linear',
	description: 'Issue tracking',
	domain: 'linear.app',
	iconPath: 'catalog/linear.png',
	connectKind: 'mcp' as const,
	endpointUrl: 'https://mcp.linear.app/mcp',
	authKind: 'oauth2' as const,
	supportsDcr: true,
	...overrides,
})

beforeEach(async () => {
	await db.delete(toolBrokerCatalog)
})

describe('catalogue sync', () => {
	it('upserts on the provider endpoint, so a re-run is idempotent', async () => {
		await syncCatalog(db, [entry()])
		await syncCatalog(db, [entry({ name: 'Linear (renamed)' })])

		const rows = await db.select().from(toolBrokerCatalog)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.name).toBe('Linear (renamed)')
	})

	it('deactivates entries that vanish upstream rather than deleting them', async () => {
		// A workspace may already have connected one; forgetting it entirely
		// would lose what it was.
		await syncCatalog(db, [
			entry(),
			entry({ endpointUrl: 'https://mcp.gone.example/mcp', domain: 'gone.example' }),
		])
		const result = await syncCatalog(db, [entry()])

		expect(result.deactivated).toBe(1)
		const [gone] = await db
			.select()
			.from(toolBrokerCatalog)
			.where(eq(toolBrokerCatalog.endpointUrl, 'https://mcp.gone.example/mcp'))
		expect(gone?.status).toBe('inactive')
	})

	it('reactivates an entry that reappears', async () => {
		await syncCatalog(db, [
			entry(),
			entry({ endpointUrl: 'https://mcp.b.example/mcp', domain: 'b.example' }),
		])
		await syncCatalog(db, [entry()])
		await syncCatalog(db, [
			entry(),
			entry({ endpointUrl: 'https://mcp.b.example/mcp', domain: 'b.example' }),
		])

		const [back] = await db
			.select()
			.from(toolBrokerCatalog)
			.where(eq(toolBrokerCatalog.endpointUrl, 'https://mcp.b.example/mcp'))
		expect(back?.status).toBe('active')
	})
})

describe('the collapse guard', () => {
	it('refuses a run that would deactivate most of the catalogue', async () => {
		// Upstream breaking must not silently empty us. 400 integrations do not
		// disappear at once; a broken fetch looks exactly like this.
		const many = Array.from({ length: 20 }, (_, i) =>
			entry({ endpointUrl: `https://mcp.e${i}.example/mcp`, domain: `e${i}.example` }),
		)
		await syncCatalog(db, many)

		await expect(syncCatalog(db, many.slice(0, 3))).rejects.toBeInstanceOf(CatalogCollapseError)
	})

	it('changes nothing at all when it refuses', async () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			entry({ endpointUrl: `https://mcp.f${i}.example/mcp`, domain: `f${i}.example` }),
		)
		await syncCatalog(db, many)
		await expect(syncCatalog(db, many.slice(0, 3))).rejects.toThrow()

		const active = await db
			.select()
			.from(toolBrokerCatalog)
			.where(eq(toolBrokerCatalog.status, 'active'))
		expect(active).toHaveLength(20)
	})

	it('allows a shrink that is plausible rather than catastrophic', async () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			entry({ endpointUrl: `https://mcp.g${i}.example/mcp`, domain: `g${i}.example` }),
		)
		await syncCatalog(db, many)

		await expect(syncCatalog(db, many.slice(0, 16))).resolves.toMatchObject({ deactivated: 4 })
	})
})

describe('nothing upstream-shaped can be stored', () => {
	it('refuses an icon URL, which is the leak this table exists to prevent', async () => {
		// An upstream icon URL in the DOM puts the catalogue source in every
		// browser request — a leak no scan of our source could ever catch.
		await expect(
			syncCatalog(db, [entry({ iconPath: 'https://example-upstream.test/icons/linear.png' })]),
		).rejects.toBeInstanceOf(CatalogNormalisationError)
	})

	it('refuses a protocol-relative icon too', async () => {
		await expect(
			syncCatalog(db, [entry({ iconPath: 'data:image/png;base64,AAAA' })]),
		).rejects.toBeInstanceOf(CatalogNormalisationError)
	})

	it('is enforced by the database, not only by the service', async () => {
		// Belt and braces: a future caller that bypasses syncCatalog still cannot
		// write a URL here.
		await expect(
			db.insert(toolBrokerCatalog).values({
				name: 'X',
				domain: 'x.example',
				iconPath: 'https://example-upstream.test/x.png',
				connectKind: 'mcp',
				endpointUrl: 'https://mcp.x.example/mcp',
				authKind: 'none',
			}),
		).rejects.toThrow()
	})

	it('accepts a storage key', async () => {
		await syncCatalog(db, [entry({ iconPath: 'catalog/icons/linear.png' })])
		const [row] = await db.select().from(toolBrokerCatalog)
		expect(row?.iconPath).toBe('catalog/icons/linear.png')
	})

	it('rejects an endpoint that is not an http url', async () => {
		await expect(syncCatalog(db, [entry({ endpointUrl: 'not-a-url' })])).rejects.toBeInstanceOf(
			CatalogNormalisationError,
		)
	})
})
