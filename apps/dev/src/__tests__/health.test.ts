import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { describe, expect, it } from 'vitest'
import { createHealthHandler } from '../lib/health'
import objectsRoute from '../routes/objects'

function appWith(execute: () => Promise<unknown>, timeoutMs = 50) {
	const app = new OpenAPIHono()
	app.get('/api/health', createHealthHandler({ execute } as unknown as Database, timeoutMs))
	return app
}

describe('Health endpoint', () => {
	it('returns 200 with status ok when the database answers', async () => {
		const res = await appWith(async () => [{ '?column?': 1 }]).request('/api/health')
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('ok')
		expect(body.timestamp).toBeDefined()
	})

	it('returns 503 when the database query fails', async () => {
		const res = await appWith(async () => {
			throw new Error('connection terminated')
		}).request('/api/health')
		expect(res.status).toBe(503)
		expect((await res.json()).status).toBe('unavailable')
	})

	it('returns 503 when the database never answers', async () => {
		const res = await appWith(() => new Promise(() => {})).request('/api/health')
		expect(res.status).toBe(503)
	})
})

describe('OpenAPI spec', () => {
	it('route modules export OpenAPIHono instances', () => {
		expect(objectsRoute).toBeDefined()
	})
})
