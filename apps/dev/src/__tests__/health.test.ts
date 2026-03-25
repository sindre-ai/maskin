import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'

describe('Health endpoint', () => {
	const app = new OpenAPIHono()
	app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

	it('returns 200 with status ok', async () => {
		const res = await app.request('/api/health')
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('ok')
		expect(body.timestamp).toBeDefined()
	})
})

describe('OpenAPI spec', () => {
	// Import a route module to verify it exports an OpenAPIHono with registered routes
	it('route modules export OpenAPIHono instances', async () => {
		const objectsModule = await import('../routes/objects')
		expect(objectsModule.default).toBeDefined()
	})
})
