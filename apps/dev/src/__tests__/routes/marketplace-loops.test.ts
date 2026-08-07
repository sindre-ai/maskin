import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: marketplaceLoopsRoutes } = await import('../../routes/marketplace-loops')

function buildMarketplaceLoop(overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		name: 'Customer Continuous Discovery',
		slug: 'customer-continuous-discovery',
		description: 'Feedback → insights → bets → lifecycle comms.',
		version: '0.1.0',
		useCase: 'continuous-discovery',
		createdAt: new Date('2026-06-01T00:00:00Z'),
		updatedAt: new Date('2026-06-01T00:00:00Z'),
		...overrides,
	}
}

function buildMarketplaceLoopItem(loopId: string, overrides?: Record<string, unknown>) {
	return {
		id: randomUUID(),
		loopId,
		itemType: 'actor',
		sourceItemId: randomUUID(),
		itemSnapshot: { kind: 'agent', name: 'Insight Clusterer' },
		createdAt: new Date('2026-06-01T00:00:00Z'),
		...overrides,
	}
}

describe('Marketplace Loops Routes', () => {
	describe('GET /api/marketplace/loops', () => {
		it('returns loops with sidebar counts computed across the full marketplace', async () => {
			const { app, mockResults } = createTestApp(marketplaceLoopsRoutes, '/api/marketplace')

			const loopA = buildMarketplaceLoop({
				name: 'Aardvark',
				slug: 'aardvark',
				useCase: 'discovery',
			})
			const loopB = buildMarketplaceLoop({
				name: 'Bear',
				slug: 'bear',
				useCase: 'growth',
			})

			mockResults.selectQueue = [
				// 1. unfiltered marketplace (id + use_case) for counts
				[
					{ id: loopA.id, useCase: loopA.useCase },
					{ id: loopB.id, useCase: loopB.useCase },
				],
				// 2. distinct item types for ALL loops
				[
					{ loopId: loopA.id, itemType: 'actor' },
					{ loopId: loopA.id, itemType: 'skill' },
					{ loopId: loopB.id, itemType: 'integration' },
				],
				// 3. filtered loop rows
				[loopA, loopB],
				// 4. distinct item types for filtered loops
				[
					{ loopId: loopA.id, itemType: 'actor' },
					{ loopId: loopA.id, itemType: 'skill' },
					{ loopId: loopB.id, itemType: 'integration' },
				],
			]

			const res = await app.request(jsonGet('/api/marketplace/loops'))
			expect(res.status).toBe(200)
			const body = await res.json()

			expect(body.loops).toHaveLength(2)
			expect(body.loops[0].name).toBe('Aardvark')
			expect(body.loops[0].item_types).toEqual(['actor', 'skill'])
			expect(body.loops[1].item_types).toEqual(['integration'])

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

		it('bins loops without a use_case under "uncategorized"', async () => {
			const { app, mockResults } = createTestApp(marketplaceLoopsRoutes, '/api/marketplace')
			const loop = buildMarketplaceLoop({ useCase: null })
			mockResults.selectQueue = [
				[{ id: loop.id, useCase: null }],
				[{ loopId: loop.id, itemType: 'skill' }],
				[loop],
				[{ loopId: loop.id, itemType: 'skill' }],
			]

			const res = await app.request(jsonGet('/api/marketplace/loops'))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.counts.by_use_case).toEqual({ uncategorized: 1 })
		})

		it('returns 400 when type query is not one of the four item types', async () => {
			const { app } = createTestApp(marketplaceLoopsRoutes, '/api/marketplace')

			const res = await app.request(jsonGet('/api/marketplace/loops?type=widget'))
			expect(res.status).toBe(400)
		})

		it('accepts use_case and q filters without 400', async () => {
			const { app, mockResults } = createTestApp(marketplaceLoopsRoutes, '/api/marketplace')
			mockResults.selectQueue = [[], [], [], []]

			const res = await app.request(jsonGet('/api/marketplace/loops?use_case=discovery&q=customer'))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.loops).toEqual([])
			expect(body.counts.total).toBe(0)
		})
	})

	describe('GET /api/marketplace/loops/:id', () => {
		it('returns the loop and its items', async () => {
			const { app, mockResults } = createTestApp(marketplaceLoopsRoutes, '/api/marketplace')
			const loop = buildMarketplaceLoop()
			const itemA = buildMarketplaceLoopItem(loop.id, { itemType: 'actor' })
			const itemB = buildMarketplaceLoopItem(loop.id, { itemType: 'skill' })

			mockResults.selectQueue = [[loop], [itemA, itemB]]

			const res = await app.request(jsonGet(`/api/marketplace/loops/${loop.id}`))
			expect(res.status).toBe(200)
			const body = await res.json()

			expect(body.loop.id).toBe(loop.id)
			expect(body.loop.use_case).toBe(loop.useCase)
			expect(body.loop.item_types).toEqual(['actor', 'skill'])
			expect(body.items).toHaveLength(2)
			expect(body.items[0].loop_id).toBe(loop.id)
			expect(body.items[0].item_snapshot).toEqual({ kind: 'agent', name: 'Insight Clusterer' })
		})

		it('returns 404 when the loop is missing', async () => {
			const { app, mockResults } = createTestApp(marketplaceLoopsRoutes, '/api/marketplace')
			mockResults.selectQueue = [[]]

			const res = await app.request(jsonGet(`/api/marketplace/loops/${randomUUID()}`))
			expect(res.status).toBe(404)
		})

		it('returns 400 when id is not a UUID', async () => {
			const { app } = createTestApp(marketplaceLoopsRoutes, '/api/marketplace')

			const res = await app.request(jsonGet('/api/marketplace/loops/not-a-uuid'))
			expect(res.status).toBe(400)
		})
	})
})
