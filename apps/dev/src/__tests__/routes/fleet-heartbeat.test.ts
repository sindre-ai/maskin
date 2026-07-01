import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: fleetHeartbeatRoutes } = await import('../../routes/fleet-heartbeat')

const SECRET = 'test-heartbeat-secret'
const PATH = '/api/internal/fleet-heartbeat'

describe('GET /api/internal/fleet-heartbeat', () => {
	beforeEach(() => {
		vi.stubEnv('HEARTBEAT_SHARED_SECRET', SECRET)
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-07-01T12:00:00Z'))
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.useRealTimers()
	})

	it('returns latest_completed_at and minutes_since on the happy path', async () => {
		const { app, mockResults } = createTestApp(fleetHeartbeatRoutes, PATH)
		// 3 minutes before "now"
		const latest = new Date('2026-07-01T11:57:00Z')
		mockResults.select = [{ latest }]

		const res = await app.request(jsonGet(PATH, { 'x-heartbeat-secret': SECRET }))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({
			latest_completed_at: '2026-07-01T11:57:00.000Z',
			minutes_since: 3,
		})
	})

	it('returns nulls when the sessions table has never completed a session', async () => {
		const { app, mockResults } = createTestApp(fleetHeartbeatRoutes, PATH)
		// max() on an empty table returns a single row with null
		mockResults.select = [{ latest: null }]

		const res = await app.request(jsonGet(PATH, { 'x-heartbeat-secret': SECRET }))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ latest_completed_at: null, minutes_since: null })
	})

	it('returns 401 with an opaque body when the secret header is missing', async () => {
		const { app } = createTestApp(fleetHeartbeatRoutes, PATH)

		const res = await app.request(jsonGet(PATH))

		expect(res.status).toBe(401)
		const body = await res.json()
		// The body must not leak whether a value was tried, its length, or its prefix.
		expect(JSON.stringify(body)).not.toContain(SECRET)
	})

	it('returns 401 when the presented secret does not match', async () => {
		const { app } = createTestApp(fleetHeartbeatRoutes, PATH)

		const res = await app.request(jsonGet(PATH, { 'x-heartbeat-secret': 'wrong-secret' }))

		expect(res.status).toBe(401)
	})

	it('surfaces a 5xx when the DB query throws', async () => {
		const { app, mockResults } = createTestApp(fleetHeartbeatRoutes, PATH)
		mockResults.selectError = new Error('connection refused')

		const res = await app.request(jsonGet(PATH, { 'x-heartbeat-secret': SECRET }))

		// The onError handler in app-factory maps unhandled throws to 500.
		// A route-level app under createTestApp doesn't mount that handler, so
		// Hono's default is used — either way, the response is >= 500 and the
		// worker treats it as silence.
		expect(res.status).toBeGreaterThanOrEqual(500)
	})

	it('returns 503 when HEARTBEAT_SHARED_SECRET is not configured', async () => {
		vi.stubEnv('HEARTBEAT_SHARED_SECRET', '')
		const { app } = createTestApp(fleetHeartbeatRoutes, PATH)

		const res = await app.request(jsonGet(PATH, { 'x-heartbeat-secret': SECRET }))

		expect(res.status).toBe(503)
	})
})
