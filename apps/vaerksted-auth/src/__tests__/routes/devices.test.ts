import { generateKeypair, issueCert, signChallenge } from '@maskin/vaerksted-crypto'
import { describe, expect, it } from 'vitest'
import { issueSessionToken } from '../../lib/session-token'
import { devicesRoute } from '../../routes/devices'
import { createTestApp } from '../setup'

const SESSION_SECRET = 'test-session-secret-at-least-16-chars'

// registerDeviceBodySchema/certSchema don't constrain device_id shape for
// POST /devices' response, but the :id route param and the device-cert
// payload both validate as real uuids (matching the `device.id` /
// `vaerksted_identity.id` column type) — use real UUIDs throughout so tests
// exercise the intended code path rather than tripping schema validation.
const DEVICE_ID = '11111111-1111-4111-8111-111111111111'
const IDENTITY_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_IDENTITY_ID = '33333333-3333-4333-8333-333333333333'
const CALLER_DEVICE_ID = '44444444-4444-4444-8444-444444444444'
const TARGET_DEVICE_ID = '55555555-5555-4555-8555-555555555555'

async function sessionHeaders(identityId: string) {
	const token = await issueSessionToken(identityId, SESSION_SECRET)
	return { Authorization: `Bearer ${token}` }
}

describe('POST /devices', () => {
	it('registers a device and issues a cert for a valid session', async () => {
		const ca = generateKeypair()
		const deviceKeys = generateKeypair()
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
			VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: ca.privateKey,
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey,
		})
		mockResults.insertQueue = [
			[
				{
					id: DEVICE_ID,
					identityId: IDENTITY_ID,
					publicKey: deviceKeys.publicKey,
					platform: 'macos',
					displayName: "Magnus's MacBook",
					revokedAt: null,
				},
			],
			[{ id: 'cert-1' }],
		]

		const res = await app.request('/devices', {
			method: 'POST',
			headers: { ...(await sessionHeaders(IDENTITY_ID)), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				public_key: deviceKeys.publicKey,
				platform: 'macos',
				display_name: "Magnus's MacBook",
			}),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.device_id).toBe(DEVICE_ID)
		expect(body.identity_id).toBe(IDENTITY_ID)
		expect(typeof body.signature).toBe('string')
		expect(
			issueCert(
				{
					deviceId: DEVICE_ID,
					identityId: IDENTITY_ID,
					publicKey: deviceKeys.publicKey,
					expiresAt: new Date(body.expires_at),
				},
				ca.privateKey,
			).signature,
		).toBe(body.signature)
	})

	it('returns 401 without a session', async () => {
		const { app } = createTestApp(devicesRoute)
		const res = await app.request('/devices', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: 'abc', platform: 'macos' }),
		})
		expect(res.status).toBe(401)
	})

	it('returns 400 for an invalid body', async () => {
		const ca = generateKeypair()
		const { app } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
			VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: ca.privateKey,
		})
		const res = await app.request('/devices', {
			method: 'POST',
			headers: { ...(await sessionHeaders(IDENTITY_ID)), 'Content-Type': 'application/json' },
			body: JSON.stringify({ platform: 'macos' }), // missing public_key
		})
		expect(res.status).toBe(400)
	})

	it('returns 503 when the CA signing key is not configured', async () => {
		const { app } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
		})
		const res = await app.request('/devices', {
			method: 'POST',
			headers: { ...(await sessionHeaders(IDENTITY_ID)), 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: 'abc', platform: 'macos' }),
		})
		expect(res.status).toBe(503)
	})

	it('returns 409 when a concurrent request wins the insert race for a new public key', async () => {
		const ca = generateKeypair()
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
			VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: ca.privateKey,
		})
		// No existing row yet (select → []), but the insert itself loses a race
		// to a concurrent registration of the same public_key.
		mockResults.insertError = Object.assign(new Error('duplicate key'), { code: '23505' })

		const res = await app.request('/devices', {
			method: 'POST',
			headers: { ...(await sessionHeaders(IDENTITY_ID)), 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: 'already-registered', platform: 'macos' }),
		})
		expect(res.status).toBe(409)
	})

	it('reissues a fresh cert (200, not 201) when the same identity re-registers its own public key — cert renewal', async () => {
		const ca = generateKeypair()
		const deviceKeys = generateKeypair()
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
			VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: ca.privateKey,
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey,
		})
		mockResults.select = [
			{
				id: DEVICE_ID,
				identityId: IDENTITY_ID,
				publicKey: deviceKeys.publicKey,
				platform: 'macos',
				displayName: "Magnus's MacBook",
				revokedAt: null,
			},
		]
		// Only the device_cert insert should happen — no second `device` row.
		mockResults.insert = [{ id: 'cert-2' }]

		const res = await app.request('/devices', {
			method: 'POST',
			headers: { ...(await sessionHeaders(IDENTITY_ID)), 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: deviceKeys.publicKey, platform: 'macos' }),
		})

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.device_id).toBe(DEVICE_ID)
		expect(
			issueCert(
				{
					deviceId: DEVICE_ID,
					identityId: IDENTITY_ID,
					publicKey: deviceKeys.publicKey,
					expiresAt: new Date(body.expires_at),
				},
				ca.privateKey,
			).signature,
		).toBe(body.signature)
	})

	it('returns 403 (not a silent un-revoke) when a revoked device tries to renew its cert', async () => {
		const ca = generateKeypair()
		const deviceKeys = generateKeypair()
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
			VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: ca.privateKey,
		})
		mockResults.select = [
			{
				id: DEVICE_ID,
				identityId: IDENTITY_ID,
				publicKey: deviceKeys.publicKey,
				platform: 'macos',
				revokedAt: new Date('2026-08-08T00:00:00Z'),
			},
		]

		const res = await app.request('/devices', {
			method: 'POST',
			headers: { ...(await sessionHeaders(IDENTITY_ID)), 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: deviceKeys.publicKey, platform: 'macos' }),
		})
		expect(res.status).toBe(403)
	})

	it('returns 409 when the public key is already registered under a different identity', async () => {
		const ca = generateKeypair()
		const deviceKeys = generateKeypair()
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
			VAERKSTED_AUTH_SIGNING_PRIVATE_KEY: ca.privateKey,
		})
		mockResults.select = [
			{
				id: DEVICE_ID,
				identityId: OTHER_IDENTITY_ID,
				publicKey: deviceKeys.publicKey,
				platform: 'macos',
				revokedAt: null,
			},
		]

		const res = await app.request('/devices', {
			method: 'POST',
			headers: { ...(await sessionHeaders(IDENTITY_ID)), 'Content-Type': 'application/json' },
			body: JSON.stringify({ public_key: deviceKeys.publicKey, platform: 'macos' }),
		})
		expect(res.status).toBe(409)
	})
})

describe('POST /devices/:id/revoke', () => {
	it('revokes a device via a valid session belonging to the same identity', async () => {
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
		})
		mockResults.select = [{ id: DEVICE_ID, identityId: IDENTITY_ID, revokedAt: null }]
		mockResults.update = [
			{ id: DEVICE_ID, identityId: IDENTITY_ID, revokedAt: new Date('2026-08-08T00:00:00Z') },
		]

		const res = await app.request(`/devices/${DEVICE_ID}/revoke`, {
			method: 'POST',
			headers: await sessionHeaders(IDENTITY_ID),
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.device_id).toBe(DEVICE_ID)
		expect(body.revoked_at).not.toBeNull()
	})

	it('revokes a device via a valid device cert for a sibling device on the same identity', async () => {
		const ca = generateKeypair()
		const callerDeviceKeys = generateKeypair()
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey,
		})

		const expiresAt = new Date(Date.now() + 60_000)
		const cert = issueCert(
			{
				deviceId: CALLER_DEVICE_ID,
				identityId: IDENTITY_ID,
				publicKey: callerDeviceKeys.publicKey,
				expiresAt,
			},
			ca.privateKey,
		)
		const nonce = 'test-nonce'
		const timestamp = Math.floor(Date.now() / 1000)
		const signature = signChallenge(callerDeviceKeys.privateKey, nonce, timestamp)

		// 1st select: device-cert-middleware's own revocation check on the
		// *caller* device (CALLER_DEVICE_ID). 2nd select: the route handler's
		// lookup of the *target* device (TARGET_DEVICE_ID).
		mockResults.selectQueue = [
			[{ id: CALLER_DEVICE_ID, identityId: IDENTITY_ID, revokedAt: null }],
			[{ id: TARGET_DEVICE_ID, identityId: IDENTITY_ID, revokedAt: null }],
		]
		mockResults.update = [
			{
				id: TARGET_DEVICE_ID,
				identityId: IDENTITY_ID,
				revokedAt: new Date('2026-08-08T00:00:00Z'),
			},
		]

		const res = await app.request(`/devices/${TARGET_DEVICE_ID}/revoke`, {
			method: 'POST',
			headers: {
				'X-Device-Cert': JSON.stringify(cert),
				'X-Nonce': nonce,
				'X-Timestamp': String(timestamp),
				'X-Signature': signature,
			},
		})
		expect(res.status).toBe(200)
	})

	it('returns 404 when the device belongs to a different identity', async () => {
		const { app, mockResults } = createTestApp(devicesRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
		})
		mockResults.select = [{ id: DEVICE_ID, identityId: OTHER_IDENTITY_ID, revokedAt: null }]

		const res = await app.request(`/devices/${DEVICE_ID}/revoke`, {
			method: 'POST',
			headers: await sessionHeaders(IDENTITY_ID),
		})
		expect(res.status).toBe(404)
	})

	it('returns 401 with no session and no device cert', async () => {
		const { app } = createTestApp(devicesRoute)
		const res = await app.request(`/devices/${DEVICE_ID}/revoke`, { method: 'POST' })
		expect(res.status).toBe(401)
	})
})
