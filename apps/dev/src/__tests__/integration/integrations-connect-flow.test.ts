import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, vi } from 'vitest'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	return { ...actual, getProvider: vi.fn(actual.getProvider) }
})

const { getProvider } = await import('../../lib/integrations/registry')
const { default: integrationsRoutes } = await import('../../routes/integrations')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

function testProvider(name: string, handleCallback: () => Promise<{ accessToken: string }>) {
	return {
		config: {
			name,
			displayName: `Test Provider ${name}`,
			auth: {
				type: 'oauth2',
				config: {
					authorizationUrl: 'http://example.test/auth',
					tokenUrl: 'http://example.test/token',
					scopes: [],
					clientIdEnv: 'TEST_CLIENT_ID',
					clientSecretEnv: 'TEST_CLIENT_SECRET',
				},
			},
		},
		// The state goes out in the install URL, as it does to a real provider.
		customAuth: {
			getInstallUrl: (state: string) => `http://example.test/auth?state=${state}`,
			handleCallback,
			getAccessToken: async () => 'token',
		},
	} as unknown as ResolvedProvider
}

function flowEvents() {
	return capturePosthogEventMock.mock.calls
		.filter(([event]) => event === 'flow_step' || event === 'flow_error')
		.map(([event, , props]) => ({ event, ...props }))
}

/** Starts a connect and hands back what the provider's page would send us back with. */
async function startConnect(app: ReturnType<typeof buildApp>, name: string, workspaceId: string) {
	const res = await app.request(`/api/integrations/${name}/connect`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify({}),
	})
	expect(res.status).toBe(200)
	const { install_url } = (await res.json()) as { install_url: string }
	const state = new URL(install_url).searchParams.get('state') as string
	const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
	return { state, cookie }
}

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('connect by sign-in — flow_step and flow_error', () => {
	it('puts connect_started, redirected_out, returned and connected on one flow_id', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const name = `test-flow-provider-${randomBytes(4).toString('hex')}`
		vi.mocked(getProvider).mockReturnValue(
			testProvider(name, async () => ({ accessToken: 'fresh' })),
		)
		const app = buildApp()

		const { state, cookie } = await startConnect(app, name, ws.id)
		const callback = await app.request(
			`/api/integrations/${name}/callback?state=${encodeURIComponent(state)}&code=abc`,
			{ headers: { cookie } },
		)
		expect(callback.status).toBe(302)

		const events = flowEvents()
		expect(events.map((e) => [e.event, e.step])).toEqual([
			['flow_step', 'connect_started'],
			['flow_step', 'redirected_out'],
			['flow_step', 'returned'],
			['flow_step', 'connected'],
		])
		expect(new Set(events.map((e) => e.flow_id)).size).toBe(1)
		expect(events[0].flow_id).toEqual(expect.any(String))
		for (const e of events) {
			expect(e).toMatchObject({
				flow: 'integration_connect',
				provider: name,
				surface: 'backend',
				workspace_id: ws.id,
				actor_id: actorId,
			})
		}
		// Time between steps is carried from the second step on.
		expect(events[0].duration_ms).toBeNull()
		expect(typeof events[3].duration_ms).toBe('number')

		const [row] = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, name)))
		expect(row.status).toBe('active')
	})

	it('sends a flow_error with a category, never the error text, when the token exchange fails', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const name = `test-flow-provider-${randomBytes(4).toString('hex')}`
		vi.mocked(getProvider).mockReturnValue(
			testProvider(name, async () => {
				throw new Error('invalid_grant for alice@example.com')
			}),
		)
		const app = buildApp()

		const { state, cookie } = await startConnect(app, name, ws.id)
		await app.request(
			`/api/integrations/${name}/callback?state=${encodeURIComponent(state)}&code=abc`,
			{ headers: { cookie } },
		)

		const events = flowEvents()
		expect(events.map((e) => [e.event, e.step])).toEqual([
			['flow_step', 'connect_started'],
			['flow_step', 'redirected_out'],
			['flow_step', 'returned'],
			['flow_error', 'returned'],
		])
		expect(new Set(events.map((e) => e.flow_id)).size).toBe(1)
		expect(events[3]).toMatchObject({ error_category: 'provider_error', provider: name })
		expect(JSON.stringify(events)).not.toContain('alice@example.com')
	})

	it('sends nothing for a state that was minted without a flow_id', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const name = `test-flow-provider-${randomBytes(4).toString('hex')}`
		vi.mocked(getProvider).mockReturnValue(
			testProvider(name, async () => ({ accessToken: 'fresh' })),
		)
		const { encrypt } = await import('../../lib/crypto')
		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: name,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
		const state = encrypt(JSON.stringify({ workspaceId: ws.id, actorId, ts: Date.now(), nonce }))

		const res = await buildApp().request(
			`/api/integrations/${name}/callback?state=${encodeURIComponent(state)}&code=abc`,
			{ headers: { cookie: `maskin_oauth_nonce_${name}=${nonce}` } },
		)

		expect(res.status).toBe(302)
		expect(flowEvents()).toEqual([])
	})
})

describe('connect by API key — flow_step', () => {
	it('sends key_submitted then connected on one flow_id', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const name = `test-flow-key-${randomBytes(4).toString('hex')}`
		vi.mocked(getProvider).mockReturnValue({
			config: {
				name,
				displayName: `Test Key Provider ${name}`,
				auth: { type: 'api_key', config: { headerName: 'Authorization', envKeyName: 'TEST_KEY' } },
			},
		} as unknown as ResolvedProvider)

		const res = await buildApp().request(`/api/integrations/${name}/connect`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': ws.id },
			body: JSON.stringify({ api_key: 'secret-key-value' }),
		})
		expect(res.status).toBe(200)

		const events = flowEvents()
		expect(events.map((e) => [e.event, e.flow, e.step])).toEqual([
			['flow_step', 'integration_key_capture', 'key_submitted'],
			['flow_step', 'integration_key_capture', 'connected'],
		])
		expect(new Set(events.map((e) => e.flow_id)).size).toBe(1)
		expect(JSON.stringify(events)).not.toContain('secret-key-value')
	})

	it('sends a validation flow_error when the key is missing', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const name = `test-flow-key-${randomBytes(4).toString('hex')}`
		vi.mocked(getProvider).mockReturnValue({
			config: {
				name,
				displayName: `Test Key Provider ${name}`,
				auth: { type: 'api_key', config: { headerName: 'Authorization', envKeyName: 'TEST_KEY' } },
			},
		} as unknown as ResolvedProvider)

		const res = await buildApp().request(`/api/integrations/${name}/connect`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': ws.id },
			body: JSON.stringify({}),
		})
		expect(res.status).toBe(400)

		expect(flowEvents().map((e) => [e.event, e.step, e.error_category])).toEqual([
			['flow_error', 'key_submitted', 'validation'],
		])
	})
})

describe('DELETE /api/integrations/:id — integration_disconnected', () => {
	function disconnect(app: ReturnType<typeof buildApp>, id: string, workspaceId: string) {
		return app.request(`/api/integrations/${id}`, {
			method: 'DELETE',
			headers: { 'X-Workspace-Id': workspaceId },
		})
	}

	function disconnectedEvents() {
		return capturePosthogEventMock.mock.calls.filter(
			([event]) => event === 'integration_disconnected',
		)
	}

	async function insertRow(workspaceId: string, status: string, ageDays: number) {
		const name = `test-disconnect-${randomBytes(4).toString('hex')}`
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: name,
				status,
				externalId: `ext-${name}`,
				credentials: '',
				createdBy: getTestActorId(),
				createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000 - 60_000),
			})
			.returning()
		return row
	}

	it('sends the provider and whole days connected for a live connection', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const row = await insertRow(ws.id, 'active', 9)
		// No provider hook for an unknown provider name: getProvider must not throw here.
		vi.mocked(getProvider).mockImplementation(() => {
			throw new Error('unknown provider')
		})

		const res = await disconnect(buildApp(), row.id, ws.id)

		expect(res.status).toBe(200)
		expect(disconnectedEvents()).toEqual([
			[
				'integration_disconnected',
				actorId,
				{ provider: row.provider, workspace_id: ws.id, actor_id: actorId, days_connected: 9 },
			],
		])
	})

	it('sends nothing for a connect that never finished', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const row = await insertRow(ws.id, 'pending', 0)
		vi.mocked(getProvider).mockImplementation(() => {
			throw new Error('unknown provider')
		})

		const res = await disconnect(buildApp(), row.id, ws.id)

		expect(res.status).toBe(200)
		expect(disconnectedEvents()).toEqual([])
	})
})
