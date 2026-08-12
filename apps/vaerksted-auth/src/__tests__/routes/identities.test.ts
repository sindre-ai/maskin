import { beforeEach, describe, expect, it, vi } from 'vitest'
import { identitiesRoute } from '../../routes/identities'
import { createTestApp } from '../setup'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
	createClient: () => ({
		auth: { getUser: getUserMock },
	}),
}))

function postIdentities(app: ReturnType<typeof createTestApp>['app'], token = 'valid-token') {
	return app.request('/identities', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ supabase_access_token: token }),
	})
}

describe('POST /identities', () => {
	beforeEach(() => {
		getUserMock.mockReset()
	})

	it('creates a new identity when none exists yet for the Supabase user', async () => {
		getUserMock.mockResolvedValue({
			data: { user: { id: 'supabase-user-1', email: 'a@example.com' } },
			error: null,
		})
		const { app, mockResults } = createTestApp(identitiesRoute)
		mockResults.select = [] // no existing identity
		mockResults.insert = [
			{ id: 'identity-1', supabaseUserId: 'supabase-user-1', email: 'a@example.com' },
		]

		const res = await postIdentities(app)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.identity_id).toBe('identity-1')
		expect(typeof body.session_token).toBe('string')
	})

	it('returns the existing identity (200) when one already exists for the Supabase user', async () => {
		getUserMock.mockResolvedValue({
			data: { user: { id: 'supabase-user-1', email: 'a@example.com' } },
			error: null,
		})
		const { app, mockResults } = createTestApp(identitiesRoute)
		mockResults.select = [
			{ id: 'identity-1', supabaseUserId: 'supabase-user-1', email: 'a@example.com' },
		]

		const res = await postIdentities(app)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.identity_id).toBe('identity-1')
	})

	it('returns 401 when the Supabase access token is invalid', async () => {
		getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('invalid token') })
		const { app } = createTestApp(identitiesRoute)

		const res = await postIdentities(app, 'bad-token')
		expect(res.status).toBe(401)
	})

	it('returns 400 for a missing supabase_access_token', async () => {
		const { app } = createTestApp(identitiesRoute)
		const res = await app.request('/identities', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(400)
	})

	it('returns 503 when Supabase is not configured', async () => {
		const { app } = createTestApp(identitiesRoute, {
			SUPABASE_URL: undefined,
			SUPABASE_SERVICE_ROLE_KEY: undefined,
		})
		const res = await postIdentities(app)
		expect(res.status).toBe(503)
	})

	it('returns 503 when the session JWT secret is not configured', async () => {
		getUserMock.mockResolvedValue({
			data: { user: { id: 'supabase-user-1', email: 'a@example.com' } },
			error: null,
		})
		const { app } = createTestApp(identitiesRoute, { VAERKSTED_AUTH_SESSION_JWT_SECRET: undefined })
		const res = await postIdentities(app)
		expect(res.status).toBe(503)
	})
})
