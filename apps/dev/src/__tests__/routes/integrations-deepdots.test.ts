import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { createTestApp } from '../setup'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'
const PASSWORD = 'p4ssw0rd-do-not-store-in-clear'

const originalFetch = globalThis.fetch
const ENV_KEYS = ['FF_TESTER_ACTOR_IDS', 'FF_TESTER_FEATURES', 'POSTHOG_API_KEY'] as const
const originalEnv: Record<string, string | undefined> = {}

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response
}

beforeEach(() => {
	for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
	process.env.FF_TESTER_ACTOR_IDS = ACTOR_ID
	process.env.FF_TESTER_FEATURES = 'deepdots-connect'
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY
	_resetFeatureFlagConfig()
})

afterEach(() => {
	globalThis.fetch = originalFetch
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key]
		else process.env[key] = originalEnv[key]
	}
	_resetFeatureFlagConfig()
	vi.restoreAllMocks()
})

async function setup() {
	const routes = (await import('../../routes/integrations-deepdots')).default
	return createTestApp(routes, '/api/integrations/deepdots', ACTOR_ID)
}

function connectRequest(body: unknown) {
	return new Request('http://localhost/api/integrations/deepdots/connect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-workspace-id': WORKSPACE_ID },
		body: JSON.stringify(body),
	})
}

describe('POST /api/integrations/deepdots/connect', () => {
	it('answers 404 while the flag is off, and calls nothing', async () => {
		process.env.FF_TESTER_FEATURES = ''
		_resetFeatureFlagConfig()
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		const { app, calls } = await setup()

		const res = await app.request(connectRequest({ email: 'a@b.com', password: PASSWORD }))

		expect(res.status).toBe(404)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(calls.inserts).toHaveLength(0)
	})

	it('refuses a wrong password on the spot and stores nothing', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ error: { message: 'Invalid email or password' } }, 401),
			) as unknown as typeof fetch
		const { app, calls } = await setup()

		const res = await app.request(connectRequest({ email: 'a@b.com', password: PASSWORD }))

		expect(res.status).toBe(400)
		const text = await res.text()
		expect(text).toContain('did not accept')
		expect(text).not.toContain(PASSWORD)
		expect(calls.inserts).toHaveLength(0)
	})

	it('says Deepdots is unreachable on a 5xx and stores nothing', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, 503)) as unknown as typeof fetch
		const { app, calls } = await setup()

		const res = await app.request(connectRequest({ email: 'a@b.com', password: PASSWORD }))

		expect(res.status).toBe(502)
		expect(calls.inserts).toHaveLength(0)
	})

	it('signs in once and stores the login encrypted, with no secret in the event', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ idToken: 'id-1', refreshToken: 'refresh-1', expiresIn: 3600 }),
			)
		globalThis.fetch = fetchMock as unknown as typeof fetch
		const { app, mockResults, calls } = await setup()
		mockResults.insert = [{ id: INTEGRATION_ID }]

		const res = await app.request(
			connectRequest({ email: 'Maskin@Example.com', password: PASSWORD }),
		)

		expect(res.status).toBe(200)
		expect(((await res.json()) as { integration_id: string }).integration_id).toBe(INTEGRATION_ID)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		const row = calls.inserts[0] as Record<string, unknown>
		expect(row.provider).toBe('deepdots')
		expect(row.status).toBe('active')
		expect(row.externalId).toBe('maskin@example.com')
		const stored = String(row.credentials)
		expect(stored).not.toContain(PASSWORD)
		expect(stored).not.toContain('refresh-1')

		const event = calls.inserts[1] as Record<string, unknown>
		expect(event.entityType).toBe('integration')
		expect(event.data).toEqual({
			provider: 'deepdots',
			external_id: 'maskin@example.com',
			auth_type: 'manual',
		})
		expect(JSON.stringify(calls.inserts)).not.toContain(PASSWORD)
	})
})
