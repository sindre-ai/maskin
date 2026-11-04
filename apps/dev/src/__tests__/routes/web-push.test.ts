import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: webPushRoutes } = await import('../../routes/web-push')

const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123'
const keys = {
	p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u',
	auth: 'tBHItJI5svbpez7KI4CCXg',
}
const row = (over: Record<string, unknown> = {}) => {
	const now = new Date()
	return {
		id: '11111111-1111-4111-8111-111111111111',
		actorId: '22222222-2222-4222-8222-222222222222',
		endpoint,
		p256dh: keys.p256dh,
		auth: keys.auth,
		userAgent: 'Chrome',
		createdAt: now,
		lastSeenAt: now,
		...over,
	}
}

afterEach(() => vi.unstubAllEnvs())

describe('GET /api/web-push/config', () => {
	it('reports disabled with no key when VAPID is not configured', async () => {
		vi.stubEnv('VAPID_PUBLIC_KEY', '')
		const { app } = createTestApp(webPushRoutes, '/api/web-push')
		const res = await app.request(jsonGet('/api/web-push/config'))
		expect(await res.json()).toEqual({ enabled: false, public_key: null })
	})

	it('serves the public key, and only the public key, when configured', async () => {
		vi.stubEnv('VAPID_PUBLIC_KEY', 'pubkey')
		vi.stubEnv('VAPID_PRIVATE_KEY', 'secret-private-key')
		vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@example.com')
		const { app } = createTestApp(webPushRoutes, '/api/web-push')
		const res = await app.request(jsonGet('/api/web-push/config'))
		const text = await res.text()
		expect(JSON.parse(text)).toEqual({ enabled: true, public_key: 'pubkey' })
		expect(text).not.toContain('secret-private-key')
	})
})

describe('POST /api/web-push/subscriptions', () => {
	it('registers a subscription and never echoes the endpoint or keys', async () => {
		const { app, mockResults, calls } = createTestApp(webPushRoutes, '/api/web-push')
		mockResults.insert = [row()]
		mockResults.select = []
		const res = await app.request(
			jsonRequest('POST', '/api/web-push/subscriptions', { endpoint, keys, user_agent: 'Chrome' }),
		)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(JSON.parse(text)).toMatchObject({ user_agent: 'Chrome' })
		expect(text).not.toContain(endpoint)
		expect(text).not.toContain(keys.auth)
		expect((calls.inserts[0] as { endpoint: string }).endpoint).toBe(endpoint)
	})

	it.each([
		['non-https endpoint', { endpoint: 'http://push.example.com/x', keys }],
		['missing keys', { endpoint }],
		['non-base64url auth', { endpoint, keys: { p256dh: keys.p256dh, auth: 'not base64!!' } }],
		['endpoint over 2048 chars', { endpoint: `https://x.example.com/${'a'.repeat(2100)}`, keys }],
		['loopback host', { endpoint: 'https://localhost/x', keys }],
		['cloud metadata IP', { endpoint: 'https://169.254.169.254/latest/meta-data', keys }],
		['private IP', { endpoint: 'https://10.0.0.5/x', keys }],
		['internal hostname', { endpoint: 'https://postgres.internal/x', keys }],
		['lookalike host', { endpoint: 'https://fcm.googleapis.com.evil.test/x', keys }],
		['credentials in URL', { endpoint: 'https://fcm.googleapis.com@127.0.0.1/x', keys }],
		['non-default port', { endpoint: 'https://fcm.googleapis.com:8443/x', keys }],
	])('rejects %s with 400', async (_name, body) => {
		const { app } = createTestApp(webPushRoutes, '/api/web-push')
		const res = await app.request(jsonRequest('POST', '/api/web-push/subscriptions', body))
		expect(res.status).toBe(400)
	})
})

describe('DELETE /api/web-push/subscriptions/:id', () => {
	it('deletes the caller’s subscription', async () => {
		const { app, mockResults } = createTestApp(webPushRoutes, '/api/web-push')
		mockResults.delete = [row()]
		const res = await app.request(
			jsonRequest('DELETE', '/api/web-push/subscriptions/11111111-1111-4111-8111-111111111111'),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })
	})

	it('404s when nothing matched (not found or not the owner)', async () => {
		const { app, mockResults } = createTestApp(webPushRoutes, '/api/web-push')
		mockResults.delete = []
		const res = await app.request(
			jsonRequest('DELETE', '/api/web-push/subscriptions/11111111-1111-4111-8111-111111111111'),
		)
		expect(res.status).toBe(404)
	})

	it('400s on a non-uuid id', async () => {
		const { app } = createTestApp(webPushRoutes, '/api/web-push')
		const res = await app.request(jsonRequest('DELETE', '/api/web-push/subscriptions/not-a-uuid'))
		expect(res.status).toBe(400)
	})
})
