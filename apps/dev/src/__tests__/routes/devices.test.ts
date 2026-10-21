import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: devicesRoutes } = await import('../../routes/devices')

const token = 'ab'.repeat(32)
const row = (over: Record<string, unknown> = {}) => {
	const now = new Date()
	return {
		id: '11111111-1111-4111-8111-111111111111',
		actorId: '22222222-2222-4222-8222-222222222222',
		platform: 'ios',
		apnsToken: token,
		environment: 'sandbox',
		appVersion: '1.0',
		createdAt: now,
		lastSeenAt: now,
		...over,
	}
}
const validBody = { platform: 'ios', apns_token: token, environment: 'sandbox', app_version: '1.0' }

describe('POST /api/devices', () => {
	it('registers a device and returns it', async () => {
		const { app, mockResults, calls } = createTestApp(devicesRoutes, '/api/devices')
		mockResults.insert = [row()]
		mockResults.select = []

		const res = await app.request(jsonRequest('POST', '/api/devices', validBody))

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			platform: 'ios',
			environment: 'sandbox',
			app_version: '1.0',
		})
		expect((calls.inserts[0] as { apnsToken: string }).apnsToken).toBe(token)
	})

	it.each([
		['non-hex token', { ...validBody, apns_token: 'zz'.repeat(32) }],
		['short token', { ...validBody, apns_token: 'ab' }],
		['unknown platform', { ...validBody, platform: 'android' }],
		['unknown environment', { ...validBody, environment: 'staging' }],
	])('returns 400 for %s', async (_name, body) => {
		const { app } = createTestApp(devicesRoutes, '/api/devices')
		const res = await app.request(jsonRequest('POST', '/api/devices', body))
		expect(res.status).toBe(400)
	})
})

describe('DELETE /api/devices/:id_or_token', () => {
	it('deletes by id', async () => {
		const { app, mockResults } = createTestApp(devicesRoutes, '/api/devices')
		mockResults.delete = [row()]
		const res = await app.request(
			jsonRequest('DELETE', '/api/devices/11111111-1111-4111-8111-111111111111'),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })
	})

	it('deletes by raw token', async () => {
		const { app, mockResults } = createTestApp(devicesRoutes, '/api/devices')
		mockResults.delete = [row()]
		const res = await app.request(jsonRequest('DELETE', `/api/devices/${token}`))
		expect(res.status).toBe(200)
	})

	it('returns 404 when the device is not the caller’s or does not exist', async () => {
		const { app, mockResults } = createTestApp(devicesRoutes, '/api/devices')
		mockResults.delete = []
		const res = await app.request(jsonRequest('DELETE', `/api/devices/${token}`))
		expect(res.status).toBe(404)
	})
})
