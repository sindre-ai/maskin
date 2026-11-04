import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { runSearchMock } = vi.hoisted(() => ({ runSearchMock: vi.fn() }))

vi.mock('../../services/search', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/search')>()
	return { ...actual, runSearch: runSearchMock }
})

const { default: searchRoutes } = await import('../../routes/search')
const { searchTokens } = await import('../../services/search')

const workspaceId = randomUUID()

function get(query: string) {
	const { app } = createTestApp(searchRoutes, '/api/search')
	return app.request(jsonGet(`/api/search${query}`, { 'x-workspace-id': workspaceId }))
}

describe('GET /api/search', () => {
	it('rejects an unknown status group with 400', async () => {
		const res = await get('?statuses=needs_you,bogus')
		expect(res.status).toBe(400)
	})

	it('rejects an unknown sort with 400', async () => {
		expect((await get('?sort=popular')).status).toBe(400)
	})

	it('rejects a query longer than 200 characters with 400', async () => {
		expect((await get(`?q=${'a'.repeat(201)}`)).status).toBe(400)
	})

	it('rejects a limit above 150 with 400', async () => {
		expect((await get('?limit=151')).status).toBe(400)
	})

	it('rejects a malformed type key with 400', async () => {
		expect((await get('?types=Not%20A%20Type')).status).toBe(400)
	})

	it('ignores an owners param, the owner filter was cut', async () => {
		runSearchMock.mockResolvedValueOnce({ results: [] })
		const res = await get('?owners=anyone')
		expect(res.status).toBe(200)
		expect(runSearchMock.mock.calls.at(-1)?.[2]).not.toHaveProperty('owners')
	})

	it('passes parsed filters and defaults to the search service', async () => {
		runSearchMock.mockResolvedValueOnce({ results: [], total: 0 })
		const res = await get('?q=hans%20customer&types=company,chat&statuses=done&sort=recent&limit=6')
		expect(res.status).toBe(200)
		const [, ctx, query] = runSearchMock.mock.calls.at(-1) ?? []
		expect(ctx).toEqual({ workspaceId, callerId: 'test-actor-id' })
		expect(query).toMatchObject({
			q: 'hans customer',
			types: ['company', 'chat'],
			statuses: ['done'],
			sort: 'recent',
			limit: 6,
		})
	})

	it('defaults to relevance sort and the 150 cap', async () => {
		runSearchMock.mockResolvedValueOnce({ results: [] })
		await get('?q=x')
		expect(runSearchMock.mock.calls.at(-1)?.[2]).toMatchObject({ sort: 'rel', limit: 150 })
	})
})

describe('searchTokens', () => {
	it('splits on whitespace, lower-cases and drops duplicates', () => {
		expect(searchTokens('  Hans   CUSTOMER hans ')).toEqual(['hans', 'customer'])
	})

	it('keeps short words and stopwords', () => {
		expect(searchTokens('a the')).toEqual(['a', 'the'])
	})

	it('keeps at most eight words', () => {
		expect(searchTokens('a b c d e f g h i j')).toHaveLength(8)
	})

	it('returns nothing for an empty query', () => {
		expect(searchTokens(undefined)).toEqual([])
		expect(searchTokens('   ')).toEqual([])
	})
})
