import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../setup'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const PASSWORD = 'abcdEFGHijklMNOPqrst'

const visible = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../routes/integrations', () => ({ providerVisible: visible }))
vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn(async () => undefined),
}))
vi.mock('../../lib/events/record-event', () => ({ recordEvent: vi.fn(async () => undefined) }))
const auditLog = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../lib/integrations/credential-audit', () => ({ insertCredentialAccessLog: auditLog }))
// A key wrapper that wraps nothing, so the envelope path runs without a master key.
vi.mock('../../lib/keychain-kms', () => ({
	getKmsProvider: () => ({
		encrypt: async (_ws: string, dek: Buffer) => `wrapped:${dek.toString('base64')}`,
		decrypt: async () => randomBytes(32),
	}),
}))
const client = vi.hoisted(() => ({
	discoverSite: vi.fn(),
	whoAmI: vi.fn(),
}))
vi.mock('../../lib/integrations/providers/wordpress-self-hosted/client', async (orig) => ({
	...(await orig<typeof import('../../lib/integrations/providers/wordpress-self-hosted/client')>()),
	...client,
}))

import { WordPressError } from '../../lib/integrations/providers/wordpress-self-hosted/client'

async function setup() {
	const routes = (await import('../../routes/integrations-wordpress-self-hosted')).default
	return createTestApp(routes, '/api/integrations/wordpress-self-hosted', ACTOR_ID)
}

function connectRequest(body: unknown) {
	return new Request('http://localhost/api/integrations/wordpress-self-hosted/connect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-workspace-id': WORKSPACE_ID },
		body: JSON.stringify(body),
	})
}

const goodBody = {
	site_url: 'https://Example.com/',
	username: 'editor',
	application_password: `abcd EFGH ${PASSWORD}`,
}

beforeEach(() => {
	visible.mockReturnValue(true)
	client.discoverSite.mockReset().mockResolvedValue({
		rest_style: 'pretty',
		name: 'Shop',
		application_passwords: true,
	})
	client.whoAmI.mockReset().mockResolvedValue({ id: 4, name: 'Ed', can_edit_posts: true })
	auditLog.mockClear()
})

describe('POST /api/integrations/wordpress-self-hosted/connect', () => {
	it('answers 404 when the flag is off for the caller', async () => {
		visible.mockReturnValue(false)
		const { app, calls } = await setup()
		const res = await app.request(connectRequest(goodBody))
		expect(res.status).toBe(404)
		expect(client.discoverSite).not.toHaveBeenCalled()
		expect(calls.inserts).toHaveLength(0)
	})

	it('refuses an http address and stores nothing', async () => {
		const { app, calls } = await setup()
		const res = await app.request(connectRequest({ ...goodBody, site_url: 'http://example.com' }))
		expect(res.status).toBe(400)
		expect(calls.inserts).toHaveLength(0)
	})

	it('refuses a wrong login with a clear message and stores nothing', async () => {
		client.whoAmI.mockRejectedValue(
			new WordPressError(
				'BAD_LOGIN',
				'WordPress did not accept this username and application password.',
			),
		)
		const { app, calls } = await setup()
		const res = await app.request(connectRequest(goodBody))
		expect(res.status).toBe(400)
		const text = await res.text()
		expect(text).toContain('did not accept')
		expect(text).not.toContain(PASSWORD)
		expect(calls.inserts).toHaveLength(0)
	})

	it('says when a host or security plugin blocks the REST address', async () => {
		client.discoverSite.mockRejectedValue(
			new WordPressError('REST_BLOCKED', 'Some hosts and security plugins block the REST address.'),
		)
		const { app, calls } = await setup()
		const res = await app.request(connectRequest(goodBody))
		expect(res.status).toBe(400)
		expect(await res.text()).toContain('security plugins')
		expect(calls.inserts).toHaveLength(0)
	})

	it('says when the site does not offer application passwords, without signing in', async () => {
		client.discoverSite.mockResolvedValue({
			rest_style: 'pretty',
			name: 'Shop',
			application_passwords: false,
		})
		const { app, calls } = await setup()
		const res = await app.request(connectRequest(goodBody))
		expect(res.status).toBe(400)
		expect(await res.text()).toContain('application passwords')
		expect(client.whoAmI).not.toHaveBeenCalled()
		expect(calls.inserts).toHaveLength(0)
	})

	it('answers 502 when the site cannot be reached', async () => {
		client.discoverSite.mockRejectedValue(
			new WordPressError('NOT_REACHABLE', 'The site took too long to answer.'),
		)
		const { app } = await setup()
		const res = await app.request(connectRequest(goodBody))
		expect(res.status).toBe(502)
	})

	it('refuses a second, different site in the same workspace', async () => {
		const { app, mockResults, calls } = await setup()
		mockResults.select = [{ id: 'int-1', externalId: 'other.com' }]
		const res = await app.request(connectRequest(goodBody))
		expect(res.status).toBe(409)
		expect(calls.inserts).toHaveLength(0)
	})

	it('stores the login as an envelope, with the password nowhere in the row or the event', async () => {
		const { app, mockResults, calls } = await setup()
		mockResults.select = []
		const res = await app.request(connectRequest(goodBody))

		expect(res.status).toBe(200)
		const { integration_id } = (await res.json()) as { integration_id: string }
		const row = calls.inserts[0] as Record<string, unknown>
		expect(row).toMatchObject({
			id: integration_id,
			provider: 'wordpress-self-hosted',
			status: 'active',
			externalId: 'example.com',
			providerMode: 'registered',
			defaultAgentAccess: 'none',
		})
		// Envelope: a wrapped key sits next to the ciphertext, and the clear password is in neither.
		expect(String(row.dekCiphertext)).toMatch(/^wrapped:/)
		expect(String(row.credentials)).not.toContain(PASSWORD)
		expect(String(row.credentials)).not.toContain('example.com')
		expect(JSON.stringify(calls.inserts)).not.toContain(PASSWORD)
		// The site was signed in to with the spaces taken out of the pasted password.
		expect(client.whoAmI.mock.calls[0]?.[0]).toMatchObject({
			site_url: 'https://example.com',
			application_password: `abcdEFGH${PASSWORD}`,
		})
		expect(auditLog).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: 'create', integrationId: integration_id }),
		)
	})

	it('replaces the login when the same site connects again, in place', async () => {
		const { app, mockResults, calls } = await setup()
		mockResults.select = [{ id: 'int-1', externalId: 'example.com' }]
		const res = await app.request(connectRequest(goodBody))

		expect(res.status).toBe(200)
		expect(((await res.json()) as { integration_id: string }).integration_id).toBe('int-1')
		expect(calls.inserts.some((i) => (i as Record<string, unknown>).provider)).toBe(false)
		const update = calls.updates[0] as Record<string, unknown>
		expect(String(update.dekCiphertext)).toMatch(/^wrapped:/)
		expect(String(update.credentials)).not.toContain(PASSWORD)
	})
})
