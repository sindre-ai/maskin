import { integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	type LinkedInMockServer,
	startLinkedInMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

/**
 * Native return target for the LinkedIn (Unipile hosted-auth) connect flow.
 * LinkedIn has its own /connect + /callback and no cookie binding: the
 * `<integrationId>.<nonce>` state, whose nonce lives in the row's encrypted
 * blob, is the binding. The allowlisted native target rides in that same blob.
 */

const NATIVE = 'maskin://integrations/callback'
const ENV_KEYS = [
	'UNIPILE_BASE_URL',
	'UNIPILE_API_KEY',
	'INTEGRATION_ENCRYPTION_KEY',
	'MASKIN_PUBLIC_URL',
	'POSTHOG_API_KEY',
	'FRONTEND_URL',
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = {}

let mock: LinkedInMockServer
let app: ReturnType<typeof createIntegrationApp>

beforeAll(async () => {
	for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
	mock = await startLinkedInMock()
	const routes = (await import('../../routes/integrations-linkedin-unipile')).default
	app = createIntegrationApp({ path: '/api/integrations/linkedin-unipile', module: routes })
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
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.MASKIN_PUBLIC_URL = 'http://localhost:3000'
	process.env.FRONTEND_URL = 'http://frontend.test'
	// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
	delete process.env.POSTHOG_API_KEY
})

function connect(workspaceId: string, body: Record<string, unknown>) {
	return app.request('/api/integrations/linkedin-unipile/connect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId },
		body: JSON.stringify(body),
	})
}

function callback(query: Record<string, string>) {
	const qs = new URLSearchParams(query).toString()
	return app.request(`/api/integrations/linkedin-unipile/callback?${qs}`)
}

function wizardState(): string {
	const req = mock.inbox().find((c) => c.path === '/v2/auth/link')
	return String((req?.body as { state?: unknown })?.state ?? '')
}

describe('linkedin-unipile connect with native_return_url', () => {
	it('refuses a return target that is not on the allowlist, before minting anything', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await connect(ws.id, { native_return_url: 'https://maskin.io.evil.test/x' })
		expect(res.status).toBe(400)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
		expect(mock.inbox().find((c) => c.path === '/v2/auth/link')).toBeUndefined()
	})

	it('redirects to the app with connected + integration_id and no credential material', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await connect(ws.id, { native_return_url: NATIVE })
		expect(res.status).toBe(200)
		const { integration_id } = (await res.json()) as { integration_id: string }

		const cb = await callback({
			state: wizardState(),
			account_id: 'linkedin-native-1',
			provider: 'linkedin',
		})
		expect(cb.status).toBe(302)
		const location = cb.headers.get('location') ?? ''
		const url = new URL(location)
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(NATIVE)
		expect(url.searchParams.get('status')).toBe('connected')
		expect(url.searchParams.get('provider')).toBe('linkedin-unipile')
		expect(url.searchParams.get('workspace_id')).toBe(ws.id)
		expect(url.searchParams.get('integration_id')).toBe(integration_id)
		expect(location).not.toContain(wizardState())
		expect(location).not.toContain('linkedin-native-1')

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integration_id))
		expect(row?.status).toBe('active')
	})

	it('reports account_restricted to the app when the state authenticates', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await connect(ws.id, { native_return_url: NATIVE })
		const cb = await callback({ error_type: 'api/restricted_account', state: wizardState() })
		const url = new URL(cb.headers.get('location') ?? '')
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(NATIVE)
		expect(url.searchParams.get('status')).toBe('error')
		expect(url.searchParams.get('reason')).toBe('account_restricted')
	})

	it('never reaches the native target on a state that does not authenticate', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await connect(ws.id, { native_return_url: NATIVE })
		const { integration_id } = (await res.json()) as { integration_id: string }
		const cb = await callback({
			error_type: 'api/restricted_account',
			state: `${integration_id}.${'0'.repeat(64)}`,
		})
		expect(cb.headers.get('location') ?? '').toContain('linkedin_status=error')
		expect(cb.headers.get('location') ?? '').not.toContain('maskin://')
	})

	it('keeps the web redirect when no native return was supplied', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await connect(ws.id, {})
		const cb = await callback({
			state: wizardState(),
			account_id: 'linkedin-web-1',
			provider: 'linkedin',
		})
		const location = cb.headers.get('location') ?? ''
		expect(location).toContain('http://frontend.test/')
		expect(location).toContain('linkedin_status=connected')
		expect(location).not.toContain('maskin://')
	})
})
