import { generateKeypair, issueCert, signChallenge } from '@maskin/vaerksted-crypto'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { deviceCertMiddleware } from '../../lib/device-cert-middleware'
import type { AppEnv } from '../../types'
import { createTestApp } from '../setup'

// certSchema (device-cert-middleware.ts) validates device_id/identity_id as
// proper uuids — matching the real `device.id`/`vaerksted_identity.id`
// column type — so every fixture below uses real UUIDs, not readable
// placeholders like 'device-1'.
const TEST_DEVICE_ID = '11111111-1111-4111-8111-111111111111'
const TEST_IDENTITY_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_IDENTITY_ID = '33333333-3333-4333-8333-333333333333'

function buildApp() {
	const route = new Hono<AppEnv>()
	route.get('/protected', deviceCertMiddleware(), (c) => {
		return c.json({ deviceId: c.get('deviceId'), identityId: c.get('identityId') })
	})
	return route
}

function buildValidRequest(
	caPrivateKey: string,
	deviceId = TEST_DEVICE_ID,
	identityId = TEST_IDENTITY_ID,
) {
	const deviceKeys = generateKeypair()
	const expiresAt = new Date(Date.now() + 60_000)
	const cert = issueCert(
		{ deviceId, identityId, publicKey: deviceKeys.publicKey, expiresAt },
		caPrivateKey,
	)
	const nonce = 'test-nonce'
	const timestamp = Math.floor(Date.now() / 1000)
	const signature = signChallenge(deviceKeys.privateKey, nonce, timestamp)
	return {
		cert,
		deviceKeys,
		headers: {
			'X-Device-Cert': JSON.stringify(cert),
			'X-Nonce': nonce,
			'X-Timestamp': String(timestamp),
			'X-Signature': signature,
		},
	}
}

describe('deviceCertMiddleware', () => {
	it('passes and sets deviceId/identityId for a valid cert + challenge signature', async () => {
		const ca = generateKeypair()
		const { app, mockResults } = createTestApp(buildApp(), {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey,
		})
		mockResults.select = [{ id: TEST_DEVICE_ID, identityId: TEST_IDENTITY_ID, revokedAt: null }]
		const { headers } = buildValidRequest(ca.privateKey)

		const res = await app.request('/protected', { headers })
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.deviceId).toBe(TEST_DEVICE_ID)
		expect(body.identityId).toBe(TEST_IDENTITY_ID)
	})

	it('rejects an expired cert', async () => {
		const ca = generateKeypair()
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey })
		const deviceKeys = generateKeypair()
		const expiresAt = new Date(Date.now() - 60_000) // already expired
		const cert = issueCert(
			{
				deviceId: TEST_DEVICE_ID,
				identityId: TEST_IDENTITY_ID,
				publicKey: deviceKeys.publicKey,
				expiresAt,
			},
			ca.privateKey,
		)
		const nonce = 'test-nonce'
		const timestamp = Math.floor(Date.now() / 1000)
		const signature = signChallenge(deviceKeys.privateKey, nonce, timestamp)

		const res = await app.request('/protected', {
			headers: {
				'X-Device-Cert': JSON.stringify(cert),
				'X-Nonce': nonce,
				'X-Timestamp': String(timestamp),
				'X-Signature': signature,
			},
		})
		expect(res.status).toBe(401)
	})

	it('rejects a cert with a tampered payload (signature no longer matches)', async () => {
		const ca = generateKeypair()
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey })
		const { cert, headers } = buildValidRequest(ca.privateKey)
		const tamperedCert = { ...cert, identity_id: OTHER_IDENTITY_ID }

		const res = await app.request('/protected', {
			headers: { ...headers, 'X-Device-Cert': JSON.stringify(tamperedCert) },
		})
		expect(res.status).toBe(401)
	})

	it('rejects a tampered challenge signature', async () => {
		const ca = generateKeypair()
		const { app, mockResults } = createTestApp(buildApp(), {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey,
		})
		mockResults.select = [{ id: TEST_DEVICE_ID, identityId: TEST_IDENTITY_ID, revokedAt: null }]
		const { headers } = buildValidRequest(ca.privateKey)

		const res = await app.request('/protected', {
			headers: { ...headers, 'X-Nonce': 'a-different-nonce-than-was-signed' },
		})
		expect(res.status).toBe(401)
	})

	it('rejects a cert issued by a key other than the configured CA public key', async () => {
		const ca = generateKeypair()
		const impostorCa = generateKeypair()
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey })
		const { headers } = buildValidRequest(impostorCa.privateKey)

		const res = await app.request('/protected', { headers })
		expect(res.status).toBe(401)
	})

	it('rejects a revoked device even with an otherwise-valid, unexpired cert', async () => {
		const ca = generateKeypair()
		const { app, mockResults } = createTestApp(buildApp(), {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey,
		})
		mockResults.select = [
			{
				id: TEST_DEVICE_ID,
				identityId: TEST_IDENTITY_ID,
				revokedAt: new Date('2026-08-01T00:00:00Z'),
			},
		]
		const { headers } = buildValidRequest(ca.privateKey)

		const res = await app.request('/protected', { headers })
		expect(res.status).toBe(401)
	})

	it('rejects when the device row no longer exists', async () => {
		const ca = generateKeypair()
		const { app, mockResults } = createTestApp(buildApp(), {
			VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey,
		})
		mockResults.select = []
		const { headers } = buildValidRequest(ca.privateKey)

		const res = await app.request('/protected', { headers })
		expect(res.status).toBe(401)
	})

	it('rejects a request missing the device-cert headers', async () => {
		const ca = generateKeypair()
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: ca.publicKey })
		const res = await app.request('/protected')
		expect(res.status).toBe(401)
	})

	it('returns 503 when VAERKSTED_AUTH_SIGNING_PUBLIC_KEY is not configured', async () => {
		const ca = generateKeypair()
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: undefined })
		const { headers } = buildValidRequest(ca.privateKey)

		const res = await app.request('/protected', { headers })
		expect(res.status).toBe(503)
	})
})
