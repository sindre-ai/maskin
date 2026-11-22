import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../setup'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'
const SECRET = 'client-secret-do-not-store-in-clear'
const API_KEY = 'api-key-do-not-store-in-clear'

const originalFetch = globalThis.fetch
const ENV_KEYS = ['POSTHOG_API_KEY', 'INTEGRATION_ENCRYPTION_KEY'] as const
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
	process.env.INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4)
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY
})

afterEach(() => {
	globalThis.fetch = originalFetch
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key]
		else process.env[key] = originalEnv[key]
	}
	vi.restoreAllMocks()
})

async function setup() {
	const routes = (await import('../../routes/integrations-dinero')).default
	return createTestApp(routes, '/api/integrations/dinero', ACTOR_ID)
}

function connectRequest(body: unknown) {
	return new Request('http://localhost/api/integrations/dinero/connect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-workspace-id': WORKSPACE_ID },
		body: JSON.stringify(body),
	})
}

const keys = { client_id: 'client-1', client_secret: SECRET, api_key: API_KEY }

/** First call is the token, second is the company list. */
function dinero(token: Response, companies?: Response) {
	return vi
		.fn()
		.mockResolvedValueOnce(token)
		.mockResolvedValueOnce(
			companies ?? jsonResponse([{ Id: 42, Name: 'Test ApS', VatNumber: '12345678' }]),
		)
}

describe('POST /api/integrations/dinero/connect', () => {
	it('refuses wrong keys on the spot and stores nothing', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, 401)) as unknown as typeof fetch
		const { app, calls } = await setup()

		const res = await app.request(connectRequest(keys))

		expect(res.status).toBe(400)
		const text = await res.text()
		expect(text).toContain('did not accept')
		expect(text).not.toContain(SECRET)
		expect(text).not.toContain(API_KEY)
		expect(calls.inserts).toHaveLength(0)
	})

	it('says Dinero is unreachable on a 5xx and stores nothing', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, 503)) as unknown as typeof fetch
		const { app, calls } = await setup()

		expect((await app.request(connectRequest(keys))).status).toBe(502)
		expect(calls.inserts).toHaveLength(0)
	})

	it('says so when the company has no Pro or Total plan, and stores nothing', async () => {
		globalThis.fetch = dinero(
			jsonResponse({ access_token: 't', expires_in: 3600 }),
			jsonResponse({}, 403),
		) as unknown as typeof fetch
		const { app, calls } = await setup()

		const res = await app.request(connectRequest(keys))

		expect(res.status).toBe(400)
		expect(await res.text()).toContain('Pro or Total')
		expect(calls.inserts).toHaveLength(0)
	})

	it('asks for the company id when the keys can see more than one, and stores nothing', async () => {
		globalThis.fetch = dinero(
			jsonResponse({ access_token: 't', expires_in: 3600 }),
			jsonResponse([
				{ Id: 1, Name: 'A' },
				{ Id: 2, Name: 'B' },
			]),
		) as unknown as typeof fetch
		const { app, calls } = await setup()

		const res = await app.request(connectRequest(keys))

		expect(res.status).toBe(400)
		expect(await res.text()).toContain('company id')
		expect(calls.inserts).toHaveLength(0)
	})

	it('signs in once and stores the keys encrypted, with no secret in the event', async () => {
		const fetchMock = dinero(jsonResponse({ access_token: 'tok-1', expires_in: 3600 }))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		const { app, mockResults, calls } = await setup()
		mockResults.insert = [{ id: INTEGRATION_ID }]

		const res = await app.request(connectRequest(keys))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ integration_id: INTEGRATION_ID, company_name: 'Test ApS' })
		expect(fetchMock).toHaveBeenCalledTimes(2)

		const row = calls.inserts[0] as Record<string, unknown>
		expect(row.provider).toBe('dinero')
		expect(row.status).toBe('active')
		expect(row.externalId).toBe('42')
		const stored = String(row.credentials)
		expect(stored).not.toContain(SECRET)
		expect(stored).not.toContain(API_KEY)
		expect(stored).not.toContain('tok-1')

		const event = calls.inserts[1] as Record<string, unknown>
		expect(event.entityType).toBe('integration')
		expect(event.data).toEqual({ provider: 'dinero', external_id: '42', auth_type: 'manual' })
		expect(JSON.stringify(calls.inserts)).not.toContain(SECRET)
		expect(JSON.stringify(calls.inserts)).not.toContain(API_KEY)
	})

	it('picks the named company when the keys can see several', async () => {
		globalThis.fetch = dinero(
			jsonResponse({ access_token: 't', expires_in: 3600 }),
			jsonResponse([
				{ Id: 1, Name: 'A' },
				{ Id: 2, Name: 'B' },
			]),
		) as unknown as typeof fetch
		const { app, mockResults, calls } = await setup()
		mockResults.insert = [{ id: INTEGRATION_ID }]

		const res = await app.request(connectRequest({ ...keys, organization_id: 2 }))

		expect(res.status).toBe(200)
		expect((calls.inserts[0] as Record<string, unknown>).externalId).toBe('2')
	})
})
