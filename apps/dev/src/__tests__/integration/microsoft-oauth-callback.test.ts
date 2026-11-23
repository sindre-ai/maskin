import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, vi } from 'vitest'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// Mock the PostHog capture so the emit is observable without an HTTP request.
// trackIntegrationConnected and the real generic callback still run end-to-end.
const { capturePosthogMock } = vi.hoisted(() => ({
	capturePosthogMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogMock,
}))

const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt } = await import('../../lib/crypto')

const FRONTEND_URL = 'https://app.test'
const TOKEN_URL = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token'
const ME_URL = 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName'

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/** Stub Microsoft at the network edge only: the token exchange and the Graph "who am I" call. */
function stubMicrosoft(me: () => Response, token?: () => Response) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url === TOKEN_URL) {
				return (
					token?.() ??
					json({
						access_token: 'eyJ.test',
						refresh_token: 'rt',
						expires_in: 3600,
						scope: 'User.Read Calendars.Read Mail.ReadWrite',
					})
				)
			}
			if (url === ME_URL) return me()
			throw new Error(`Unexpected outbound fetch in microsoft callback test: ${url}`)
		}),
	)
}

async function seedPendingConnect() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const nonce = randomBytes(16).toString('hex')
	await db.insert(integrations).values({
		workspaceId: ws.id,
		provider: 'microsoft',
		status: 'pending',
		externalId: nonce,
		credentials: '',
		createdBy: actorId,
	})
	const state = encrypt(
		JSON.stringify({
			workspaceId: ws.id,
			actorId,
			ts: Date.now(),
			nonce,
			codeVerifier: 'verifier',
		}),
	)
	return { actorId, ws, nonce, state }
}

function callback(state: string, nonce: string) {
	const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
	return app.request(
		`/api/integrations/microsoft/callback?state=${encodeURIComponent(state)}&code=auth-code`,
		{ headers: { cookie: `maskin_oauth_nonce_microsoft=${nonce}` } },
	)
}

async function microsoftRows(workspaceId: string) {
	return db
		.select()
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'microsoft')))
}

function connectedCalls() {
	return capturePosthogMock.mock.calls.filter(([event]) => event === 'integration_connected')
}

// Microsoft has no connect emit of its own: the generic callback fires integration_connected once
// the row is active. This pins that Microsoft is covered, under its own provider value, and that a
// failed connect emits nothing. The Outlook tools fire integration_tool_called under the same value
// (see the Microsoft mcp-server test), so connect and use read as one provider in PostHog.
describe('GET /api/integrations/microsoft/callback — integration_connected', () => {
	beforeEach(() => {
		capturePosthogMock.mockClear()
		vi.stubEnv('MICROSOFT_CLIENT_ID', 'ms-client-id')
		vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'ms-client-secret')
		vi.stubEnv('FRONTEND_URL', FRONTEND_URL)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('emits integration_connected once with provider microsoft after the row is active', async () => {
		const { actorId, ws, nonce, state } = await seedPendingConnect()
		stubMicrosoft(() => json({ mail: 'Ada@Example.com', userPrincipalName: 'ada@example.com' }))

		const res = await callback(state, nonce)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`${FRONTEND_URL}/${ws.id}/settings/integrations`)

		const rows = await microsoftRows(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('active')
		expect(rows[0].externalId).toBe('ada@example.com')

		expect(connectedCalls()).toEqual([
			[
				'integration_connected',
				actorId,
				{
					provider: 'microsoft',
					workspace_id: ws.id,
					actor_id: actorId,
					integration_id: rows[0].id,
					auth_type: 'oauth',
					is_backfill: false,
				},
			],
		])
	})

	it('emits nothing when Microsoft refuses the sign-in code', async () => {
		const { nonce, state } = await seedPendingConnect()
		stubMicrosoft(
			() => json({}),
			() => json({ error: 'invalid_grant' }, 400),
		)

		const res = await callback(state, nonce)

		expect(res.status).not.toBe(200)
		expect(connectedCalls()).toHaveLength(0)
	})
})
