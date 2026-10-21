import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: routes } = await import('../../routes/notification-preferences')
const URL = '/api/notification-preferences'

describe('GET /api/notification-preferences', () => {
	it('returns defaults when the actor has no row', async () => {
		const { app, mockResults } = createTestApp(routes, URL)
		mockResults.select = []
		const res = await app.request(jsonRequest('GET', URL))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			timezone: null,
			quiet_hours_start: null,
			quiet_hours_end: null,
			categories: { needs_you: true, conversation: true, digest: true, tips: true },
			briefing_enabled: true,
			briefing_time: 510,
			muted_workspace_ids: [],
			updated_at: null,
		})
	})
})

describe('PUT /api/notification-preferences validation', () => {
	it.each([
		['unknown timezone', { timezone: 'Mars/Olympus' }],
		['offset-style timezone', { timezone: '+02:00' }],
		['quiet start out of range', { quiet_hours_start: 1440, quiet_hours_end: 10 }],
		['negative quiet end', { quiet_hours_start: 10, quiet_hours_end: -1 }],
		['only one quiet bound', { quiet_hours_start: 10 }],
		['one quiet bound null, other set', { quiet_hours_start: null, quiet_hours_end: 10 }],
		['briefing time out of range', { briefing_time: 2000 }],
		['non-uuid muted workspace', { muted_workspace_ids: ['nope'] }],
		['unknown category value', { categories: { needs_you: 'yes' } }],
	])('returns 400 for %s', async (_n, body) => {
		const { app } = createTestApp(routes, URL)
		const res = await app.request(jsonRequest('PUT', URL, body))
		expect(res.status).toBe(400)
	})
})
