import { authMiddleware } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { mintIntakeKey } from '../../../lib/receipt-intake/policy'

// A command key must open nothing but the receipt upload route. The rest of the API authenticates
// through authMiddleware, which only accepts actor keys (ank_) and connector tokens. This proves a
// receipt key is refused there before the database is asked anything.

const forbiddenDb = new Proxy(
	{},
	{
		get() {
			throw new Error('database touched for a receipt key')
		},
	},
) as unknown as Database

describe('a receipt key outside the upload route', () => {
	it('is refused by the API auth, and never reaches the database', async () => {
		const app = new Hono()
		app.use('/api/*', authMiddleware(forbiddenDb))
		app.get('/api/objects', (c) => c.json({ data: 'secret' }))
		app.post('/api/objects', (c) => c.json({ created: true }))
		app.get('/api/files', (c) => c.json({ data: 'secret' }))

		const { key } = mintIntakeKey()
		for (const [method, path] of [
			['GET', '/api/objects'],
			['POST', '/api/objects'],
			['GET', '/api/files'],
		] as const) {
			const res = await app.request(path, {
				method,
				headers: { Authorization: `Bearer ${key}`, 'X-Workspace-Id': crypto.randomUUID() },
			})
			expect(res.status).toBe(401)
		}
	})
})
