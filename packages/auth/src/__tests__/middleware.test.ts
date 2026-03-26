import type { Database } from '@ai-native/db'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authMiddleware } from '../middleware'
import { createMockDb } from './helpers'

type Env = {
	Variables: {
		actorId: string
		actorType: string
	}
}

/**
 * Creates a test Hono app with authMiddleware and a simple echo route
 * that returns the actorId and actorType from context.
 */
function createTestApp(db: Database) {
	const app = new Hono<Env>()
	app.use('*', authMiddleware(db))
	app.get('/test', (c) => {
		return c.json({
			actorId: c.get('actorId'),
			actorType: c.get('actorType'),
		})
	})
	return app
}

describe('authMiddleware', () => {
	it('returns 401 when Authorization header is missing', async () => {
		const app = createTestApp(createMockDb([]))
		const res = await app.request('/test')
		expect(res.status).toBe(401)
		const body = await res.json()
		expect(body.error.code).toBe('UNAUTHORIZED')
	})

	it('returns 401 when Authorization header has no Bearer prefix', async () => {
		const app = createTestApp(createMockDb([]))
		const res = await app.request('/test', {
			headers: { Authorization: 'Basic abc123' },
		})
		expect(res.status).toBe(401)
	})

	it('returns 401 when token does not start with ank_', async () => {
		const app = createTestApp(createMockDb([]))
		const res = await app.request('/test', {
			headers: { Authorization: 'Bearer some-other-token' },
		})
		expect(res.status).toBe(401)
		const body = await res.json()
		expect(body.error.message).toBe('Invalid token format')
	})

	it('returns 401 when API key is invalid (no matching actor)', async () => {
		const db = createMockDb([[]])  // validateApiKey returns empty
		const app = createTestApp(db)
		const res = await app.request('/test', {
			headers: { Authorization: 'Bearer ank_invalidkey' },
		})
		expect(res.status).toBe(401)
		const body = await res.json()
		expect(body.error.message).toBe('Invalid API key')
	})

	it('passes through with actorId/actorType when API key is valid (no workspace)', async () => {
		const db = createMockDb([
			[{ id: 'actor-1', type: 'human' }],  // validateApiKey finds actor
		])
		const app = createTestApp(db)
		const res = await app.request('/test', {
			headers: { Authorization: 'Bearer ank_validkey' },
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.actorId).toBe('actor-1')
		expect(body.actorType).toBe('human')
	})

	it('passes through when valid key + workspace header + actor is member', async () => {
		const db = createMockDb([
			[{ id: 'actor-1', type: 'agent' }],     // validateApiKey finds actor
			[{ actorId: 'actor-1' }],                 // workspace membership check passes
		])
		const app = createTestApp(db)
		const res = await app.request('/test', {
			headers: {
				Authorization: 'Bearer ank_validkey',
				'X-Workspace-Id': 'ws-123',
			},
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.actorId).toBe('actor-1')
		expect(body.actorType).toBe('agent')
	})

	it('returns 404 when valid key + workspace header but actor is not member', async () => {
		const db = createMockDb([
			[{ id: 'actor-1', type: 'human' }],  // validateApiKey finds actor
			[],                                    // workspace membership check fails
		])
		const app = createTestApp(db)
		const res = await app.request('/test', {
			headers: {
				Authorization: 'Bearer ank_validkey',
				'X-Workspace-Id': 'ws-999',
			},
		})
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.error.message).toBe('Workspace not found')
	})
})
