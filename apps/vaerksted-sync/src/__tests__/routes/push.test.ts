import { describe, expect, it } from 'vitest'
import { pushRoute } from '../../routes/push'
import { buildAuthFixture, buildAuthHeaders } from '../fixtures'
import { createTestApp } from '../setup'

describe('POST /sync/push', () => {
	it('inserts a sync_blob row and returns 201 with the full stored row', async () => {
		const fixture = buildAuthFixture()
		const { app, mockResults } = createTestApp(pushRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixture.ca.publicKey,
		})

		const storedRow = {
			id: 'blob-1',
			deviceId: fixture.deviceId,
			identityId: fixture.identityId,
			meetingId: 'meeting-123',
			field: 'title',
			logicalClock: 5,
			payload: 'New title',
			serverSeq: 42,
			createdAt: new Date('2026-08-08T12:00:00.000Z'),
		}
		mockResults.insert = [storedRow]

		const res = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixture) },
			body: JSON.stringify({
				meeting_id: 'meeting-123',
				field: 'title',
				logical_clock: 5,
				payload: 'New title',
			}),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body).toEqual({
			id: 'blob-1',
			device_id: fixture.deviceId,
			identity_id: fixture.identityId,
			meeting_id: 'meeting-123',
			field: 'title',
			logical_clock: 5,
			payload: 'New title',
			server_seq: 42,
			created_at: '2026-08-08T12:00:00.000Z',
		})
	})

	it('rejects a request with no device-cert headers', async () => {
		const { app } = createTestApp(pushRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: 'deadbeef',
		})

		const res = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ meeting_id: 'm1', field: 'title', logical_clock: 1, payload: 'x' }),
		})

		expect(res.status).toBe(401)
	})

	it('rejects a cert signed by a different key than the server trusts', async () => {
		const fixture = buildAuthFixture()
		const wrongCaPublicKey = buildAuthFixture().ca.publicKey
		const { app } = createTestApp(pushRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: wrongCaPublicKey,
		})

		const res = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixture) },
			body: JSON.stringify({ meeting_id: 'm1', field: 'title', logical_clock: 1, payload: 'x' }),
		})

		expect(res.status).toBe(401)
	})

	it('rejects an expired device cert', async () => {
		const fixture = buildAuthFixture({ expiresAt: new Date(Date.now() - 1000) })
		const { app } = createTestApp(pushRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixture.ca.publicKey,
		})

		const res = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixture) },
			body: JSON.stringify({ meeting_id: 'm1', field: 'title', logical_clock: 1, payload: 'x' }),
		})

		expect(res.status).toBe(401)
	})

	it('rejects a body missing required fields with 400', async () => {
		const fixture = buildAuthFixture()
		const { app } = createTestApp(pushRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixture.ca.publicKey,
		})

		const res = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixture) },
			body: JSON.stringify({ meeting_id: 'm1' }),
		})

		expect(res.status).toBe(400)
	})

	it('ignores a client-supplied device_id/identity_id in the body and uses the cert instead', async () => {
		const fixture = buildAuthFixture()
		const { app, mockResults } = createTestApp(pushRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixture.ca.publicKey,
		})

		const storedRow = {
			id: 'blob-2',
			deviceId: fixture.deviceId,
			identityId: fixture.identityId,
			meetingId: 'm1',
			field: 'notes',
			logicalClock: 1,
			payload: 'hello',
			serverSeq: 1,
			createdAt: new Date(),
		}
		mockResults.insert = [storedRow]

		const res = await app.request('/sync/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(fixture) },
			// Attacker-supplied device_id/identity_id in the body — the route
			// schema doesn't even accept these fields, so they're dropped.
			body: JSON.stringify({
				meeting_id: 'm1',
				field: 'notes',
				logical_clock: 1,
				payload: 'hello',
				device_id: 'attacker-device',
				identity_id: 'attacker-identity',
			}),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.device_id).toBe(fixture.deviceId)
		expect(body.identity_id).toBe(fixture.identityId)
	})
})
