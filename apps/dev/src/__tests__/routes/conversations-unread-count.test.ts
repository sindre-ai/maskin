import conversationsRoutes from '../../routes/conversations'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const url = '/api/conversations/unread-count'

describe('GET /api/conversations/unread-count', () => {
	it('returns the count from the single count query', async () => {
		const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
		mockResults.select = [{ count: 4 }]

		const res = await app.request(jsonGet(url, { 'X-Workspace-Id': crypto.randomUUID() }))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ count: 4 })
	})

	it('returns 0 when the query yields no row', async () => {
		const { app, mockResults } = createTestApp(conversationsRoutes, '/api/conversations')
		mockResults.select = []

		const res = await app.request(jsonGet(url, { 'X-Workspace-Id': crypto.randomUUID() }))

		expect(await res.json()).toEqual({ count: 0 })
	})

	it('rejects a missing or malformed workspace header with 400', async () => {
		const { app } = createTestApp(conversationsRoutes, '/api/conversations')

		const missing = await app.request(jsonGet(url))
		const bad = await app.request(jsonGet(url, { 'X-Workspace-Id': 'nope' }))

		expect(missing.status).toBe(400)
		expect(bad.status).toBe(400)
	})
})
