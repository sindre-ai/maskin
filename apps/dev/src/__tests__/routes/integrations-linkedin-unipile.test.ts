import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	startUnipileMock,
	type UnipileMockServer,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { createTestApp } from '../setup'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'
const WEBHOOK_SECRET = 'test-webhook-secret'
const ENCRYPTION_KEY = 'a'.repeat(64)

const ORIGINAL_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = [
	'UNIPILE_BASE_URL',
	'UNIPILE_API_KEY',
	'UNIPILE_WEBHOOK_SECRET',
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
	process.env.UNIPILE_WEBHOOK_SECRET = WEBHOOK_SECRET
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.MASKIN_PUBLIC_URL = 'http://localhost:3000'
	// Turn off PostHog capture so we don't hit the network in tests.
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

function rawPost(path: string, body: string, headers: Record<string, string> = {}) {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body,
	})
}

function signBody(body: string, secret = WEBHOOK_SECRET): string {
	return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

// ── POST /connect ──────────────────────────────────────────────────────────

describe('POST /api/integrations/linkedin-unipile/connect', () => {
	it('inserts a pending row and returns the Unipile install_url', async () => {
		const routes = await importRoutes()
		const { app, mockResults, calls } = createTestApp(
			routes,
			'/api/integrations/linkedin-unipile',
			ACTOR_ID,
		)
		mockResults.selectQueue = [[]]
		mockResults.insert = [{ id: INTEGRATION_ID }]

		const res = await app.request(
			jsonPost('/api/integrations/linkedin-unipile/connect', {}, {
				'x-workspace-id': WORKSPACE_ID,
			}),
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

		// And that Unipile received a create-link call with the right shape.
		const linkCall = mock.inbox().find((c) => c.path === '/api/v1/hosted/accounts/link')
		expect(linkCall).toBeDefined()
		expect((linkCall?.body as Record<string, unknown>).providers).toEqual(['LINKEDIN'])
		expect((linkCall?.body as Record<string, unknown>).name).toBe(INTEGRATION_ID)
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
			jsonPost('/api/integrations/linkedin-unipile/connect', {}, {
				'x-workspace-id': WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(200)
		expect(calls.inserts).toHaveLength(0)
	})
})

// ── POST /callback ─────────────────────────────────────────────────────────

describe('POST /api/integrations/linkedin-unipile/callback', () => {
	it('rejects a request with a missing signature', async () => {
		const routes = await importRoutes()
		const { app } = createTestApp(routes, '/api/integrations/linkedin-unipile')

		const body = JSON.stringify({ status: 'CREATION_SUCCESS', account_id: 'acc-1' })
		const res = await app.request(rawPost('/api/integrations/linkedin-unipile/callback', body))
		expect(res.status).toBe(401)
	})

	it('rejects a request with an invalid signature', async () => {
		const routes = await importRoutes()
		const { app } = createTestApp(routes, '/api/integrations/linkedin-unipile')

		const body = JSON.stringify({ status: 'CREATION_SUCCESS', account_id: 'acc-1' })
		const res = await app.request(
			rawPost('/api/integrations/linkedin-unipile/callback', body, {
				'X-Unipile-Signature': 'deadbeef',
			}),
		)
		expect(res.status).toBe(401)
	})

	it('acknowledges a non-CREATION_SUCCESS payload without touching the DB', async () => {
		const routes = await importRoutes()
		const { app, calls } = createTestApp(routes, '/api/integrations/linkedin-unipile')

		const body = JSON.stringify({ status: 'CREATION_FAILED', name: INTEGRATION_ID })
		const res = await app.request(
			rawPost('/api/integrations/linkedin-unipile/callback', body, {
				'X-Unipile-Signature': signBody(body),
			}),
		)
		expect(res.status).toBe(200)
		expect(calls.updates).toHaveLength(0)
	})

	it('returns 404 when the pending row cannot be found', async () => {
		const routes = await importRoutes()
		const { app, mockResults } = createTestApp(routes, '/api/integrations/linkedin-unipile')
		mockResults.select = []

		const body = JSON.stringify({
			status: 'CREATION_SUCCESS',
			account_id: 'acc-1',
			name: INTEGRATION_ID,
		})
		const res = await app.request(
			rawPost('/api/integrations/linkedin-unipile/callback', body, {
				'X-Unipile-Signature': signBody(body),
			}),
		)
		expect(res.status).toBe(404)
	})

	it('marks the row connected with encrypted credentials on the happy path', async () => {
		const routes = await importRoutes()
		const { app, mockResults, calls } = createTestApp(
			routes,
			'/api/integrations/linkedin-unipile',
		)
		mockResults.select = [
			{
				id: INTEGRATION_ID,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				provider: 'linkedin-unipile',
				status: 'pending',
			},
		]

		const body = JSON.stringify({
			status: 'CREATION_SUCCESS',
			account_id: 'unipile-account-42',
			name: INTEGRATION_ID,
		})
		const res = await app.request(
			rawPost('/api/integrations/linkedin-unipile/callback', body, {
				'X-Unipile-Signature': signBody(body),
			}),
		)
		expect(res.status).toBe(200)

		expect(calls.updates).toHaveLength(1)
		const update = calls.updates[0] as Record<string, unknown>
		expect(update.status).toBe('connected')
		expect(update.externalId).toBe('unipile-account-42')
		// credentials is the encrypted JSON blob — assert on shape (iv:tag:ct)
		// rather than the exact ciphertext, which contains a random IV.
		expect(String(update.credentials)).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i)
	})
})
