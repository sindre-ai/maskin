import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: catalogPackagesRoutes } = await import('../../routes/catalog-packages')

function buildCatalogPackage(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		name: 'Customer Continuous Discovery',
		slug: 'customer-continuous-discovery',
		description: 'Feedback → insights → bets → lifecycle comms.',
		version: '0.1.0',
		useCase: 'continuous-discovery',
		category: 'discovery',
		createdAt: new Date('2026-06-01T00:00:00Z'),
		updatedAt: new Date('2026-06-01T00:00:00Z'),
		...overrides,
	}
}

function buildCatalogPackageItem(packageId: string, overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		packageId,
		itemType: 'actor',
		sourceItemId: randomUUID(),
		itemSnapshot: { kind: 'agent', name: 'Insight Clusterer' },
		createdAt: new Date('2026-06-01T00:00:00Z'),
		...overrides,
	}
}

describe('Catalog Packages Routes', () => {
	describe('GET /api/catalog/packages', () => {
		it('returns packages with sidebar counts computed across the full catalog', async () => {
			const { app, mockResults } = createTestApp(catalogPackagesRoutes, '/api/catalog')

			const pkgA = buildCatalogPackage({
				name: 'Aardvark',
				slug: 'aardvark',
				useCase: 'discovery',
			})
			const pkgB = buildCatalogPackage({
				name: 'Bear',
				slug: 'bear',
				useCase: 'growth',
			})

			mockResults.selectQueue = [
				// 1. unfiltered catalog (id + use_case) for counts
				[
					{ id: pkgA.id, useCase: pkgA.useCase },
					{ id: pkgB.id, useCase: pkgB.useCase },
				],
				// 2. distinct item types for ALL packages
				[
					{ packageId: pkgA.id, itemType: 'actor' },
					{ packageId: pkgA.id, itemType: 'skill' },
					{ packageId: pkgB.id, itemType: 'integration' },
				],
				// 3. filtered package rows
				[pkgA, pkgB],
				// 4. distinct item types for filtered packages
				[
					{ packageId: pkgA.id, itemType: 'actor' },
					{ packageId: pkgA.id, itemType: 'skill' },
					{ packageId: pkgB.id, itemType: 'integration' },
				],
			]

			const res = await app.request(jsonGet('/api/catalog/packages'))
			expect(res.status).toBe(200)
			const body = await res.json()

			expect(body.packages).toHaveLength(2)
			expect(body.packages[0].name).toBe('Aardvark')
			expect(body.packages[0].item_types).toEqual(['actor', 'skill'])
			expect(body.packages[0].category).toBe('discovery')
			expect(body.packages[1].item_types).toEqual(['integration'])

			expect(body.counts.total).toBe(2)
			expect(body.counts.by_type).toEqual({
				actor: 1,
				trigger: 0,
				skill: 1,
				integration: 1,
			})
			expect(body.counts.by_use_case).toEqual({
				discovery: 1,
				growth: 1,
			})
		})

		it('bins packages without a use_case under "uncategorized"', async () => {
			const { app, mockResults } = createTestApp(catalogPackagesRoutes, '/api/catalog')
			const pkg = buildCatalogPackage({ useCase: null })
			mockResults.selectQueue = [
				[{ id: pkg.id, useCase: null }],
				[{ packageId: pkg.id, itemType: 'skill' }],
				[pkg],
				[{ packageId: pkg.id, itemType: 'skill' }],
			]

			const res = await app.request(jsonGet('/api/catalog/packages'))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.counts.by_use_case).toEqual({ uncategorized: 1 })
		})

		it('returns 400 when type query is not one of the four item types', async () => {
			const { app } = createTestApp(catalogPackagesRoutes, '/api/catalog')

			const res = await app.request(jsonGet('/api/catalog/packages?type=widget'))
			expect(res.status).toBe(400)
		})

		it('accepts use_case and q filters without 400', async () => {
			const { app, mockResults } = createTestApp(catalogPackagesRoutes, '/api/catalog')
			mockResults.selectQueue = [[], [], [], []]

			const res = await app.request(jsonGet('/api/catalog/packages?use_case=discovery&q=customer'))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.packages).toEqual([])
			expect(body.counts.total).toBe(0)
		})
	})

	describe('GET /api/catalog/packages/:id', () => {
		it('returns the package and its items', async () => {
			const { app, mockResults } = createTestApp(catalogPackagesRoutes, '/api/catalog')
			const pkg = buildCatalogPackage()
			const itemA = buildCatalogPackageItem(pkg.id, { itemType: 'actor' })
			const itemB = buildCatalogPackageItem(pkg.id, { itemType: 'skill' })

			mockResults.selectQueue = [[pkg], [itemA, itemB]]

			const res = await app.request(jsonGet(`/api/catalog/packages/${pkg.id}`))
			expect(res.status).toBe(200)
			const body = await res.json()

			expect(body.package.id).toBe(pkg.id)
			expect(body.package.use_case).toBe(pkg.useCase)
			expect(body.package.category).toBe('discovery')
			expect(body.package.item_types).toEqual(['actor', 'skill'])
			expect(body.items).toHaveLength(2)
			expect(body.items[0].package_id).toBe(pkg.id)
			expect(body.items[0].item_snapshot).toEqual({ kind: 'agent', name: 'Insight Clusterer' })
		})

		it('returns 404 when the package is missing', async () => {
			const { app, mockResults } = createTestApp(catalogPackagesRoutes, '/api/catalog')
			mockResults.selectQueue = [[]]

			const res = await app.request(jsonGet(`/api/catalog/packages/${randomUUID()}`))
			expect(res.status).toBe(404)
		})

		it('returns 400 when id is not a UUID', async () => {
			const { app } = createTestApp(catalogPackagesRoutes, '/api/catalog')

			const res = await app.request(jsonGet('/api/catalog/packages/not-a-uuid'))
			expect(res.status).toBe(400)
		})
	})
})
