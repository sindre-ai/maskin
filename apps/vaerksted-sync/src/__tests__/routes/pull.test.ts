import { describe, expect, it } from 'vitest'
import { pullRoute } from '../../routes/pull'
import { buildAuthFixture, buildAuthHeaders } from '../fixtures'
import { createTestApp } from '../setup'

describe('GET /sync/pull', () => {
	it('returns rows for the identity, mapped to the wire shape', async () => {
		const fixture = buildAuthFixture()
		const { app, mockResults } = createTestApp(pullRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixture.ca.publicKey,
		})

		mockResults.select = [
			{
				id: 'blob-1',
				deviceId: fixture.deviceId,
				identityId: fixture.identityId,
				meetingId: 'm1',
				field: 'title',
				logicalClock: 3,
				payload: 'Hello',
				serverSeq: 10,
				createdAt: new Date('2026-08-08T12:00:00.000Z'),
			},
		]

		const res = await app.request('/sync/pull?since=5', {
			headers: buildAuthHeaders(fixture),
		})

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({
			blobs: [
				{
					id: 'blob-1',
					device_id: fixture.deviceId,
					identity_id: fixture.identityId,
					meeting_id: 'm1',
					field: 'title',
					logical_clock: 3,
					payload: 'Hello',
					server_seq: 10,
					created_at: '2026-08-08T12:00:00.000Z',
				},
			],
		})
	})

	it('rejects an unauthenticated request', async () => {
		const { app } = createTestApp(pullRoute, { VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: 'deadbeef' })

		const res = await app.request('/sync/pull')

		expect(res.status).toBe(401)
	})

	it('treats a missing or invalid since as 0 rather than erroring', async () => {
		const fixture = buildAuthFixture()
		const { app, mockResults } = createTestApp(pullRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: fixture.ca.publicKey,
		})
		mockResults.select = []

		const resMissing = await app.request('/sync/pull', { headers: buildAuthHeaders(fixture) })
		expect(resMissing.status).toBe(200)

		const resInvalid = await app.request('/sync/pull?since=not-a-number', {
			headers: buildAuthHeaders(fixture),
		})
		expect(resInvalid.status).toBe(200)

		const resNegative = await app.request('/sync/pull?since=-5', {
			headers: buildAuthHeaders(fixture),
		})
		expect(resNegative.status).toBe(200)
	})
})
