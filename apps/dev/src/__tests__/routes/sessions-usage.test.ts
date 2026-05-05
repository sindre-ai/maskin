import { describe, expect, it } from 'vitest'
import { jsonGet } from '../helpers'
import { createSessionTestApp } from '../setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

const wsId = '00000000-0000-0000-0000-000000000001'
const actorId = '00000000-0000-0000-0000-000000000042'

describe('GET /api/sessions/usage', () => {
	it('rejects when `to` is not after `from`', async () => {
		const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')
		const url = `/api/sessions/usage?actor_id=${actorId}&from=2026-01-10T00:00:00Z&to=2026-01-10T00:00:00Z&bucket=day`
		const res = await app.request(jsonGet(url, { 'x-workspace-id': wsId }))
		expect(res.status).toBe(400)
	})

	it('rejects ranges greater than 366 days', async () => {
		const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')
		const url = `/api/sessions/usage?actor_id=${actorId}&from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z&bucket=day`
		const res = await app.request(jsonGet(url, { 'x-workspace-id': wsId }))
		expect(res.status).toBe(400)
	})

	it('rejects hourly bucket on ranges > 60 days', async () => {
		const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')
		const url = `/api/sessions/usage?actor_id=${actorId}&from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z&bucket=hour`
		const res = await app.request(jsonGet(url, { 'x-workspace-id': wsId }))
		expect(res.status).toBe(400)
	})

	it('rejects an invalid actor_id', async () => {
		const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')
		const url =
			'/api/sessions/usage?actor_id=not-a-uuid&from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z&bucket=day'
		const res = await app.request(jsonGet(url, { 'x-workspace-id': wsId }))
		expect(res.status).toBe(400)
	})

	it('rejects a missing bucket', async () => {
		const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')
		const url = `/api/sessions/usage?actor_id=${actorId}&from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z`
		const res = await app.request(jsonGet(url, { 'x-workspace-id': wsId }))
		expect(res.status).toBe(400)
	})
})
