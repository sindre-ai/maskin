import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type UnipileMockServer,
	startUnipileMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { createTestApp } from '../setup'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'
const ENCRYPTION_KEY = 'a'.repeat(64)

const ORIGINAL_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = [
	'UNIPILE_BASE_URL',
	'UNIPILE_API_KEY',
	'INTEGRATION_ENCRYPTION_KEY',
	'MASKIN_PUBLIC_URL',
	'POSTHOG_API_KEY',
] as const

let mock: UnipileMockServer

// A single mock Unipile server for the whole suite — starting one per test
// costs ~20ms extra and the mock's inbox is reset before every test.
beforeAll(async () => {
	for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
	mock = await startUnipileMock()
})

afterAll(async () => {
	await mock.close()
	for (const key of ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
		else process.env[key] = ORIGINAL_ENV[key]
	}
})

beforeEach(() => {
	mock.resetInbox()
	process.env.UNIPILE_BASE_URL = mock.baseUrl
	process.env.UNIPILE_API_KEY = 'test-api-key'
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.MASKIN_PUBLIC_URL = 'http://localhost:3000'
	// Turn off PostHog capture so we don't hit the network in tests.
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY
})

afterEach(() => {
	vi.restoreAllMocks()
})

async function importRoutes() {
	// Fresh import per test-suite import so env changes above take effect for
	// any module that reads process.env at import time.
	return (await import('../../routes/integrations-linkedin-unipile')).default
}

function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

function callbackGetRequest(query: Record<string, string>) {
	const url = new URL('http://localhost/api/integrations/linkedin-unipile/callback')
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
	return new Request(url.toString(), { method: 'GET' })
}

// ── POST /connect ──────────────────────────────────────────────────────────

describe('POST /api/integrations/linkedin-unipile/connect', () => {
	it('inserts a pending row and returns the Unipile v2 install_url', async () => {
		const routes = await importRoutes()
		const { app, mockResults, calls } = createTestApp(
			routes,
			'/api/integrations/linkedin-unipile',
			ACTOR_ID,
		)
		mockResults.selectQueue = [[]]
		mockResults.insert = [{ id: INTEGRATION_ID }]

		const res = await app.request(
			jsonPost(
				'/api/integrations/linkedin-unipile/connect',
				{},
				{
					'x-workspace-id': WORKSPACE_ID,
				},
			),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { install_url: string; integration_id: string }
		expect(body.install_url).toContain(mock.baseUrl)
		expect(body.integration_id).toBe(INTEGRATION_ID)

		// Confirm the row we inserted matches the spec's shape.
		expect(calls.inserts).toHaveLength(1)
		const inserted = calls.inserts[0] as Record<string, unknown>
		expect(inserted.workspaceId).toBe(WORKSPACE_ID)
		expect(inserted.actorId).toBe(ACTOR_ID)
		expect(inserted.provider).toBe('linkedin-unipile')
		expect(inserted.status).toBe('pending')
		expect(inserted.credentials).toBe('')

		// And that Unipile received a v2 auth-link call with the right shape.
		const linkCall = mock.inbox().find((c) => c.path === '/v2/auth/link')
		expect(linkCall).toBeDefined()
		const linkBody = linkCall?.body as Record<string, unknown>
		expect(linkBody.providers).toEqual(['linkedin'])
		expect(linkBody.state).toBe(INTEGRATION_ID)
		expect(typeof linkBody.expires_on).toBe('string')
		expect(linkBody.redirect_uri).toBe(
			'http://localhost:3000/api/integrations/linkedin-unipile/callback',
		)
	})

	it('reuses an existing non-connected row instead of inserting a duplicate', async () => {
		const routes = await importRoutes()
		const { app, mockResults, calls } = createTestApp(
			routes,
			'/api/integrations/linkedin-unipile',
			ACTOR_ID,
		)
		mockResults.selectQueue = [
			[
				{
					id: INTEGRATION_ID,
					workspaceId: WORKSPACE_ID,
					actorId: ACTOR_ID,
					provider: 'linkedin-unipile',
					status: 'pending',
				},
			],
		]

		const res = await app.request(
			jsonPost(
				'/api/integrations/linkedin-unipile/connect',
				{},
				{
					'x-workspace-id': WORKSPACE_ID,
				},
			),
		)

		expect(res.status).toBe(200)
		expect(calls.inserts).toHaveLength(0)
	})
})

// ── GET /callback ──────────────────────────────────────────────────────────

describe('GET /api/integrations/linkedin-unipile/callback', () => {
	it('redirects to Settings with error when required success params are missing', async () => {
		const routes = await importRoutes()
		const { app } = createTestApp(routes, '/api/integrations/linkedin-unipile')

		const res = await app.request(
			callbackGetRequest({ account_id: 'acc-1' }), // missing state + provider
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location') ?? '').toContain('linkedin_status=error')
	})

	it('redirects to error when provider is not "linkedin"', async () => {
		const routes = await importRoutes()
		const { app } = createTestApp(routes, '/api/integrations/linkedin-unipile')

		const res = await app.request(
			callbackGetRequest({
				state: INTEGRATION_ID,
				account_id: 'acc-1',
				provider: 'whatsapp',
			}),
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location') ?? '').toContain('linkedin_status=error')
		expect(res.headers.get('location') ?? '').toContain('linkedin_detail=wrong_provider')
	})

	it('redirects to error unknown_state when no pending row matches', async () => {
		const routes = await importRoutes()
		const { app, mockResults } = createTestApp(routes, '/api/integrations/linkedin-unipile')
		mockResults.select = []

		const res = await app.request(
			callbackGetRequest({
				state: INTEGRATION_ID,
				account_id: 'acc-1',
				provider: 'linkedin',
			}),
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location') ?? '').toContain('linkedin_detail=unknown_state')
	})

	it('marks the row active with encrypted credentials on the happy path', async () => {
		const routes = await importRoutes()
		const { app, mockResults, calls } = createTestApp(routes, '/api/integrations/linkedin-unipile')
		mockResults.select = [
			{
				id: INTEGRATION_ID,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				provider: 'linkedin-unipile',
				status: 'pending',
			},
		]

		const res = await app.request(
			callbackGetRequest({
				state: INTEGRATION_ID,
				account_id: 'unipile-account-42',
				provider: 'linkedin',
			}),
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location') ?? '').toContain('linkedin_status=connected')
		expect(res.headers.get('location') ?? '').toContain('linkedin_detail=unipile-account-42')

		expect(calls.updates).toHaveLength(1)
		const update = calls.updates[0] as Record<string, unknown>
		// 'active' — not 'connected'. This must match the literal every reader
		// filters on (lib/integrations/lookup.ts, oauth/token-manager.ts,
		// routes/integrations.ts); see the integration test for the round-trip
		// proof that getIntegrationCredential can actually find this row.
		expect(update.status).toBe('active')
		expect(update.externalId).toBe('unipile-account-42')
		// credentials is the encrypted JSON blob — assert on shape (iv:tag:ct)
		// rather than the exact ciphertext, which contains a random IV.
		expect(String(update.credentials)).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i)
	})

	it('adopts an api/already_exists callback into the pending row', async () => {
		const routes = await importRoutes()
		const { app, mockResults, calls } = createTestApp(routes, '/api/integrations/linkedin-unipile')
		mockResults.select = [
			{
				id: INTEGRATION_ID,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				provider: 'linkedin-unipile',
				status: 'pending',
			},
		]

		const res = await app.request(
			callbackGetRequest({
				state: INTEGRATION_ID,
				error_type: 'api/already_exists',
				error_detail: 'existing-unipile-77',
			}),
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location') ?? '').toContain('linkedin_status=connected')
		expect(res.headers.get('location') ?? '').toContain('linkedin_detail=existing-unipile-77')

		expect(calls.updates).toHaveLength(1)
		const update = calls.updates[0] as Record<string, unknown>
		expect(update.status).toBe('active')
		expect(update.externalId).toBe('existing-unipile-77')
	})

	it('routes api/restricted_account to the restricted-account error surface without flipping status', async () => {
		const routes = await importRoutes()
		const { app, calls } = createTestApp(routes, '/api/integrations/linkedin-unipile')

		const res = await app.request(
			callbackGetRequest({
				state: INTEGRATION_ID,
				error_type: 'api/restricted_account',
				error_detail: 'restricted-by-linkedin',
			}),
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location') ?? '').toContain('linkedin_status=error')
		expect(res.headers.get('location') ?? '').toContain('linkedin_detail=account_restricted')
		expect(calls.updates).toHaveLength(0)
	})

	it('routes an unknown error_type to error with the raw value as detail', async () => {
		const routes = await importRoutes()
		const { app, calls } = createTestApp(routes, '/api/integrations/linkedin-unipile')

		const res = await app.request(
			callbackGetRequest({
				state: INTEGRATION_ID,
				error_type: 'api/some_new_thing',
			}),
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location') ?? '').toContain('linkedin_status=error')
		expect(res.headers.get('location') ?? '').toContain('linkedin_detail=api%2Fsome_new_thing')
		expect(calls.updates).toHaveLength(0)
	})
})
