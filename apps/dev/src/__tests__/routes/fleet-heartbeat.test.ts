import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: fleetHeartbeatRoutes } = await import('../../routes/fleet-heartbeat')

const SECRET = 'test-heartbeat-secret'
const PATH = '/api/internal/fleet-heartbeat'

describe('GET /api/internal/fleet-heartbeat', () => {
	beforeEach(() => {
		vi.stubEnv('HEARTBEAT_SHARED_SECRET', SECRET)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.useRealTimers()
	})

	it('returns 200 with latest_completed_at + minutes_since when a session row exists', async () => {
		const { app, mockResults } = createTestApp(fleetHeartbeatRoutes, PATH)
		vi.useFakeTimers()
		const now = new Date('2026-07-01T12:00:00.000Z')
		vi.setSystemTime(now)
		const latest = new Date('2026-07-01T11:57:30.000Z') // 2.5 min → floor to 2
		mockResults.select = [{ latestCompletedAt: latest }]

		const res = await app.request(jsonGet(PATH, { 'X-Heartbeat-Secret': SECRET }))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.latest_completed_at).toBe(latest.toISOString())
		expect(body.minutes_since).toBe(2)
	})

	it('returns 200 with nulls when the sessions table is empty', async () => {
		const { app, mockResults } = createTestApp(fleetHeartbeatRoutes, PATH)
		mockResults.select = [{ latestCompletedAt: null }]

		const res = await app.request(jsonGet(PATH, { 'X-Heartbeat-Secret': SECRET }))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.latest_completed_at).toBeNull()
		expect(body.minutes_since).toBeNull()
	})

	it('returns 401 when the X-Heartbeat-Secret header is missing', async () => {
		const { app } = createTestApp(fleetHeartbeatRoutes, PATH)

		const res = await app.request(jsonGet(PATH))

		expect(res.status).toBe(401)
		const body = await res.json()
		// Body must not leak which auth condition failed.
		expect(JSON.stringify(body)).not.toContain('missing')
		expect(JSON.stringify(body)).not.toContain('wrong')
	})

	it('returns 401 when the shared secret does not match', async () => {
		const { app } = createTestApp(fleetHeartbeatRoutes, PATH)

		const res = await app.request(jsonGet(PATH, { 'X-Heartbeat-Secret': 'not-the-right-secret' }))

		expect(res.status).toBe(401)
	})

	it('propagates DB errors as 5xx (default onError path)', async () => {
		const { app, mockResults } = createTestApp(fleetHeartbeatRoutes, PATH)
		mockResults.selectError = new Error('connection refused')
		app.onError((_err, c) => c.json({ error: 'internal' }, 500))

		const res = await app.request(jsonGet(PATH, { 'X-Heartbeat-Secret': SECRET }))

		expect(res.status).toBeGreaterThanOrEqual(500)
		expect(res.status).toBeLessThan(600)
	})

	it('returns 503 when HEARTBEAT_SHARED_SECRET is not configured', async () => {
		vi.stubEnv('HEARTBEAT_SHARED_SECRET', '')
		const { app } = createTestApp(fleetHeartbeatRoutes, PATH)

		const res = await app.request(jsonGet(PATH, { 'X-Heartbeat-Secret': SECRET }))

		expect(res.status).toBe(503)
	})
})
