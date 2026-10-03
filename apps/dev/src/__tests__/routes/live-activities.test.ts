import { describe, expect, it } from 'vitest'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: routes } = await import('../../routes/live-activities')

const uuid = '11111111-1111-4111-8111-111111111111'
const sessionUuid = '33333333-3333-4333-8333-333333333333'
const token = 'ab'.repeat(40)

describe('POST /api/live-activities/tokens validation', () => {
	it.each([
		['update without session_id', { kind: 'update', device_id: uuid, token }],
		[
			'push_to_start with session_id',
			{ kind: 'push_to_start', device_id: uuid, session_id: sessionUuid, token },
		],
		['non-hex token', { kind: 'push_to_start', device_id: uuid, token: 'zz'.repeat(20) }],
		['short token', { kind: 'push_to_start', device_id: uuid, token: 'ab' }],
		['unknown kind', { kind: 'alert', device_id: uuid, token }],
		['non-uuid device_id', { kind: 'push_to_start', device_id: 'nope', token }],
	])('returns 400 for %s', async (_name, body) => {
		const { app } = createTestApp(routes, '/api/live-activities')
		const res = await app.request(jsonRequest('POST', '/api/live-activities/tokens', body))
		expect(res.status).toBe(400)
	})

	it('returns 404 when the device is not the caller’s', async () => {
		const { app, mockResults } = createTestApp(routes, '/api/live-activities')
		mockResults.select = []
		const res = await app.request(
			jsonRequest('POST', '/api/live-activities/tokens', {
				kind: 'push_to_start',
				device_id: uuid,
				token,
			}),
		)
		expect(res.status).toBe(404)
	})
})

describe('DELETE /api/live-activities/tokens/:id', () => {
	it('returns 404 when nothing was deleted', async () => {
		const { app, mockResults } = createTestApp(routes, '/api/live-activities')
		mockResults.delete = []
		const res = await app.request(jsonRequest('DELETE', `/api/live-activities/tokens/${uuid}`))
		expect(res.status).toBe(404)
	})

	it('rejects a non-uuid id with 400', async () => {
		const { app } = createTestApp(routes, '/api/live-activities')
		const res = await app.request(jsonRequest('DELETE', '/api/live-activities/tokens/not-a-uuid'))
		expect(res.status).toBe(400)
	})
})
