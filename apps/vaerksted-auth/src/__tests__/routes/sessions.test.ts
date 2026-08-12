import { beforeEach, describe, expect, it, vi } from 'vitest'
import { issueSessionToken } from '../../lib/session-token'
import { sessionsRoute } from '../../routes/sessions'
import { createTestApp } from '../setup'

const SESSION_SECRET = 'test-session-secret-at-least-16-chars'
const IDENTITY_ID = '22222222-2222-4222-8222-222222222222'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
	createClient: () => ({
		auth: { getUser: getUserMock },
	}),
}))

function postSessions(app: ReturnType<typeof createTestApp>['app'], token = 'valid-token') {
	return app.request('/sessions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ supabase_access_token: token }),
	})
}

describe('POST /sessions', () => {
	beforeEach(() => {
		getUserMock.mockReset()
	})

	it('issues a session token for an existing identity', async () => {
		getUserMock.mockResolvedValue({
			data: { user: { id: 'supabase-user-1', email: 'a@example.com' } },
			error: null,
		})
		const { app, mockResults } = createTestApp(sessionsRoute)
		mockResults.select = [
			{ id: 'identity-1', supabaseUserId: 'supabase-user-1', email: 'a@example.com' },
		]

		const res = await postSessions(app)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.identity_id).toBe('identity-1')
		expect(typeof body.session_token).toBe('string')
	})

	it('returns 404 when no identity exists yet for the Supabase user', async () => {
		getUserMock.mockResolvedValue({
			data: { user: { id: 'supabase-user-1', email: 'a@example.com' } },
			error: null,
		})
		const { app, mockResults } = createTestApp(sessionsRoute)
		mockResults.select = []

		const res = await postSessions(app)
		expect(res.status).toBe(404)
	})

	it('returns 401 when the Supabase access token is invalid', async () => {
		getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('invalid token') })
		const { app } = createTestApp(sessionsRoute)

		const res = await postSessions(app, 'bad-token')
		expect(res.status).toBe(401)
	})

	it('returns 400 for a missing supabase_access_token', async () => {
		const { app } = createTestApp(sessionsRoute)
		const res = await app.request('/sessions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(400)
	})
})

describe('GET /sessions/me', () => {
	it('returns the identity for a valid session token', async () => {
		const { app, mockResults } = createTestApp(sessionsRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
		})
		mockResults.select = [
			{ id: IDENTITY_ID, supabaseUserId: 'supabase-user-1', email: 'a@example.com' },
		]
		const token = await issueSessionToken(IDENTITY_ID, SESSION_SECRET)

		const res = await app.request('/sessions/me', {
			headers: { Authorization: `Bearer ${token}` },
		})

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({ identity_id: IDENTITY_ID, email: 'a@example.com' })
	})

	it('returns 401 without a session token', async () => {
		const { app } = createTestApp(sessionsRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
		})
		const res = await app.request('/sessions/me')
		expect(res.status).toBe(401)
	})

	it('returns 401 for an invalid/expired session token', async () => {
		const { app } = createTestApp(sessionsRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
		})
		const res = await app.request('/sessions/me', {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})

	it('returns 404 when the session identity no longer exists', async () => {
		const { app, mockResults } = createTestApp(sessionsRoute, {
			VAERKSTED_AUTH_SESSION_JWT_SECRET: SESSION_SECRET,
		})
		mockResults.select = []
		const token = await issueSessionToken(IDENTITY_ID, SESSION_SECRET)

		const res = await app.request('/sessions/me', {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(res.status).toBe(404)
	})
})
