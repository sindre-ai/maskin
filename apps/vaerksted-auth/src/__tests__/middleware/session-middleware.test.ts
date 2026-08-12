import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { sessionMiddleware } from '../../lib/session-middleware'
import { issueSessionToken } from '../../lib/session-token'
import type { AppEnv } from '../../types'
import { createTestApp } from '../setup'

const SECRET = 'test-session-secret-at-least-16-chars'

function buildApp() {
	const route = new Hono<AppEnv>()
	route.get('/protected', sessionMiddleware(), (c) => {
		return c.json({ identityId: c.get('identityId') })
	})
	return route
}

describe('sessionMiddleware', () => {
	it('passes and sets identityId for a valid session token', async () => {
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SESSION_JWT_SECRET: SECRET })
		const token = await issueSessionToken('identity-1', SECRET)

		const res = await app.request('/protected', {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.identityId).toBe('identity-1')
	})

	it('rejects a missing Authorization header', async () => {
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SESSION_JWT_SECRET: SECRET })
		const res = await app.request('/protected')
		expect(res.status).toBe(401)
	})

	it('rejects an expired session token', async () => {
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SESSION_JWT_SECRET: SECRET })
		const key = new TextEncoder().encode(SECRET)
		const expiredToken = await new SignJWT({ identityId: 'identity-1' })
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
			.setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
			.sign(key)

		const res = await app.request('/protected', {
			headers: { Authorization: `Bearer ${expiredToken}` },
		})
		expect(res.status).toBe(401)
	})

	it('rejects a token signed with a different secret (tampered/forged signature)', async () => {
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SESSION_JWT_SECRET: SECRET })
		const forgedToken = await issueSessionToken('identity-1', 'a-completely-different-secret!!')

		const res = await app.request('/protected', {
			headers: { Authorization: `Bearer ${forgedToken}` },
		})
		expect(res.status).toBe(401)
	})

	it('rejects a structurally tampered token (payload segment altered)', async () => {
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SESSION_JWT_SECRET: SECRET })
		const token = await issueSessionToken('identity-1', SECRET)
		const [header, , signature] = token.split('.')
		const tamperedPayload = Buffer.from(
			JSON.stringify({ identityId: 'attacker-identity' }),
		).toString('base64url')
		const tamperedToken = `${header}.${tamperedPayload}.${signature}`

		const res = await app.request('/protected', {
			headers: { Authorization: `Bearer ${tamperedToken}` },
		})
		expect(res.status).toBe(401)
	})

	it('returns 503 when VAERKSTED_AUTH_SESSION_JWT_SECRET is not configured', async () => {
		const { app } = createTestApp(buildApp(), { VAERKSTED_AUTH_SESSION_JWT_SECRET: undefined })
		const token = await issueSessionToken('identity-1', SECRET)

		const res = await app.request('/protected', {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(res.status).toBe(503)
	})
})
