import type { Database } from '@maskin/db'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authMiddleware } from '../middleware'
import { SELECT_CALL_COUNT, createMockDb } from './helpers'

type Env = { Variables: { actorId: string; actorType: string } }

const KEY = 'Bearer ank_cachedkey'
const WS = '11111111-1111-4111-8111-111111111111'
const ACTOR_ROW = { id: 'actor-1', type: 'human' }
const MEMBER_ROW = { actorId: 'actor-1' }

function appWith(db: Database, cacheTtlMs: number) {
	const app = new Hono<Env>()
	app.use('*', authMiddleware(db, { cacheTtlMs }))
	app.get('/test', (c) => c.json({ actorId: c.get('actorId') }))
	return app
}

const request = (app: ReturnType<typeof appWith>) =>
	app.request('/test', { headers: { Authorization: KEY, 'X-Workspace-Id': WS } })

const selects = (db: Database) => (db as unknown as Record<string, number>)[SELECT_CALL_COUNT]

describe('authMiddleware lookup caching', () => {
	it('looks up the key and membership once for repeated requests', async () => {
		const db = createMockDb([[ACTOR_ROW], [MEMBER_ROW]])
		const app = appWith(db, 60_000)

		for (let i = 0; i < 5; i++) expect((await request(app)).status).toBe(200)

		expect(selects(db)).toBe(2)
	})

	it('collapses a parallel burst into one lookup per key', async () => {
		const db = createMockDb([[ACTOR_ROW], [MEMBER_ROW]])
		const app = appWith(db, 60_000)

		const results = await Promise.all(Array.from({ length: 10 }, () => request(app)))

		expect(results.every((r) => r.status === 200)).toBe(true)
		expect(selects(db)).toBe(2)
	})

	it('asks the database every time when caching is disabled', async () => {
		const db = createMockDb([[ACTOR_ROW], [MEMBER_ROW], [ACTOR_ROW], [MEMBER_ROW]])
		const app = appWith(db, 0)

		await request(app)
		await request(app)

		expect(selects(db)).toBe(4)
	})

	it('does not cache an invalid key, so a key created later works immediately', async () => {
		const db = createMockDb([[], [ACTOR_ROW], [MEMBER_ROW]])
		const app = appWith(db, 60_000)

		expect((await request(app)).status).toBe(401)
		expect((await request(app)).status).toBe(200)
	})

	it('does not cache a missing membership', async () => {
		const db = createMockDb([[ACTOR_ROW], [], [MEMBER_ROW]])
		const app = appWith(db, 60_000)

		expect((await request(app)).status).toBe(404)
		expect((await request(app)).status).toBe(200)
	})
})
