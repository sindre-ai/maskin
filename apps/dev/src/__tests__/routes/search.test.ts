import { randomUUID } from 'node:crypto'
import { encodeSearchCursor } from '../../lib/search/ranking'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: searchRoutes } = await import('../../routes/search')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'X-Workspace-Id': wsId }

function post(body: unknown, h: Record<string, string> = headers) {
	return jsonRequest('POST', '/api/search', body, h)
}

function objectRow(overrides: Record<string, unknown> = {}) {
	return {
		id: randomUUID(),
		title: 'Launch plan',
		type: 'bet',
		status: 'active',
		score: 1000,
		ms: 1760000000000,
		head: '',
		...overrides,
	}
}

describe('POST /api/search validation', () => {
	it.each([
		['missing query', {}],
		['empty query', { query: '' }],
		['whitespace-only query', { query: '   ' }],
		['over-long query', { query: 'x'.repeat(201) }],
		['unknown scope', { query: 'a', scope: 'everything' }],
		['limit 0', { query: 'a', limit: 0 }],
		['limit above max', { query: 'a', limit: 51 }],
		['non-integer limit', { query: 'a', limit: 2.5 }],
		['string limit', { query: 'a', limit: 'abc' }],
		['bad object_type', { query: 'a', object_type: 'Not Valid' }],
	])('returns 400 for %s', async (_name, body) => {
		const { app } = createTestApp(searchRoutes, '/api/search')
		const res = await app.request(post(body))
		expect(res.status).toBe(400)
	})

	it('returns 400 for a cursor this server did not mint', async () => {
		const { app } = createTestApp(searchRoutes, '/api/search')
		const res = await app.request(post({ query: 'plan', cursor: 'garbage' }))
		expect(res.status).toBe(400)
	})

	it('requires a valid X-Workspace-Id header', async () => {
		const { app } = createTestApp(searchRoutes, '/api/search')
		expect((await app.request(post({ query: 'plan' }, {}))).status).toBe(400)
		expect(
			(await app.request(post({ query: 'plan' }, { 'X-Workspace-Id': 'not-a-uuid' }))).status,
		).toBe(400)
	})
})

describe('POST /api/search results', () => {
	it('returns merged, ranked results with first-page counts', async () => {
		const { app, mockResults } = createTestApp(searchRoutes, '/api/search')
		const hi = objectRow({ title: 'Launch plan', score: 1000 })
		const lo = objectRow({ title: 'Notes', score: 33, head: 'we should plan the launch' })
		// call order: objects page, then counts (objects, loops, actors, conversations)
		mockResults.selectQueue = [
			[lo, hi],
			[{ id: 'a' }, { id: 'b' }],
			[],
			[{ id: 'x' }],
			[{ id: 'y' }],
		]

		const res = await app.request(post({ query: 'launch plan', scope: 'objects' }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.results.map((r: { id: string }) => r.id)).toEqual([hi.id, lo.id])
		expect(body.results[0]).toMatchObject({ kind: 'object', type: 'bet', status: 'active' })
		expect(body.results[0].snippet).toBeUndefined()
		expect(body.results[1].snippet).toBe('we should plan the launch')
		expect(body.counts).toEqual({ objects: 2, loops: 0, team: 2, capped: false })
		expect(body.next_cursor).toBeUndefined()
	})

	it('emits next_cursor only when more rows exist than the limit', async () => {
		const { app, mockResults } = createTestApp(searchRoutes, '/api/search')
		const rows = [
			objectRow({ score: 90, id: '00000000-0000-0000-0000-00000000000a' }),
			objectRow({ score: 80, id: '00000000-0000-0000-0000-00000000000b' }),
			objectRow({ score: 70, id: '00000000-0000-0000-0000-00000000000c' }),
		]
		mockResults.selectQueue = [rows, [], [], [], []]
		const res = await app.request(post({ query: 'plan', scope: 'objects', limit: 2 }))
		const body = await res.json()
		expect(body.results).toHaveLength(2)
		expect(body.next_cursor).toEqual(
			encodeSearchCursor({ s: 80, u: 1760000000000, i: '00000000-0000-0000-0000-00000000000b' }),
		)
	})

	it('accepts a cursor and omits counts on continuation pages', async () => {
		const { app, mockResults } = createTestApp(searchRoutes, '/api/search')
		const cursor = encodeSearchCursor({ s: 80, u: 1, i: randomUUID() })
		mockResults.selectQueue = [[objectRow({ score: 10 })]]
		const res = await app.request(post({ query: 'plan', scope: 'objects', cursor }))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.results).toHaveLength(1)
		expect(body.counts).toBeUndefined()
		expect(body.next_cursor).toBeUndefined()
	})

	it('flags capped counts', async () => {
		const { app, mockResults } = createTestApp(searchRoutes, '/api/search')
		const many = Array.from({ length: 100 }, () => ({ id: randomUUID() }))
		mockResults.selectQueue = [[], many, [], [], []]
		const body = await (await app.request(post({ query: 'plan', scope: 'objects' }))).json()
		expect(body.counts).toEqual({ objects: 100, loops: 0, team: 0, capped: true })
	})

	it('labels actors and conversations by name/title and merges the team scope', async () => {
		const { app, mockResults } = createTestApp(searchRoutes, '/api/search')
		const actor = { id: randomUUID(), title: 'Ada Lovelace', type: 'human', score: 1400, ms: 5 }
		const conv = { id: randomUUID(), title: 'Ada sync', score: 430, ms: 9 }
		// team scope: actors page, conversations page, then 4 counts
		mockResults.selectQueue = [[actor], [conv], [], [], [], []]
		const body = await (await app.request(post({ query: 'ada', scope: 'team' }))).json()
		expect(body.results).toMatchObject([
			{ kind: 'actor', title: 'Ada Lovelace', type: 'human' },
			{ kind: 'conversation', title: 'Ada sync' },
		])
		expect(body.results[1].snippet).toBeUndefined()
	})
})
