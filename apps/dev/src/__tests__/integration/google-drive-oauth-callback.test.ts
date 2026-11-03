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
const PEOPLE_URL = 'https://people.googleapis.com/v1/people/me?personFields=metadata'
const START_PAGE_TOKEN_URL =
	'https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true'
const WATCH_URL = 'https://www.googleapis.com/drive/v3/changes/watch?'

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/**
 * Stub Google at the network edge only. The real google-drive provider config,
 * the real generic callback and real Postgres all run; only the three Google
 * hosts the connect talks to are faked (token, userinfo, People, and the Drive
 * change feed postInstall opens its channel on). Every other URL fails loudly.
 */
function stubGoogle(handlers: { people: () => Response; watch?: () => Response }) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url === 'https://oauth2.googleapis.com/token') {
				return json({ access_token: 'ya29.test', refresh_token: 'rt', expires_in: 3600 })
			}
			if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
				return json({ email: 'drive-user@example.com' })
			}
			if (url === PEOPLE_URL) return handlers.people()
			if (url === START_PAGE_TOKEN_URL) return json({ startPageToken: 'start-1' })
			if (url.startsWith(WATCH_URL)) {
				return (
					handlers.watch?.() ??
					json({ resourceId: 'resource-1', expiration: String(Date.now() + 6 * 24 * 3600_000) })
				)
			}
			throw new Error(`Unexpected outbound fetch in google-drive callback test: ${url}`)
		}),
	)
}

async function seedPendingConnect() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const nonce = randomBytes(16).toString('hex')
	await db.insert(integrations).values({
		workspaceId: ws.id,
		provider: 'google-drive',
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
		`/api/integrations/google-drive/callback?state=${encodeURIComponent(state)}&code=auth-code`,
		{ headers: { cookie: `maskin_oauth_nonce_google-drive=${nonce}` } },
	)
}

async function driveRows(workspaceId: string) {
	return db
		.select()
		.from(integrations)
		.where(
			and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'google-drive')),
		)
}

function connectedCalls() {
	return capturePosthogMock.mock.calls.filter(([event]) => event === 'integration_connected')
}

// The Drive connect path has no emit of its own: the generic callback fires
// integration_connected once the row is active and postInstall has passed. This
// pins that google-drive is covered by it, and that a failed connect emits nothing.
describe('GET /api/integrations/google-drive/callback — integration_connected', () => {
	beforeEach(() => {
		capturePosthogMock.mockClear()
		vi.stubEnv('GOOGLE_DRIVE_CLIENT_ID', 'drive-client-id')
		vi.stubEnv('GOOGLE_DRIVE_CLIENT_SECRET', 'drive-client-secret')
		vi.stubEnv('FRONTEND_URL', FRONTEND_URL)
		vi.stubEnv('GOOGLE_DRIVE_CHANNEL_TOKEN_SECRET', 'drive-channel-secret')
		vi.stubEnv('MASKIN_PUBLIC_URL', 'https://api.test')
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('emits integration_connected once with provider google-drive after the row is active', async () => {
		const { actorId, ws, nonce, state } = await seedPendingConnect()
		stubGoogle({
			people: () =>
				json({ metadata: { sources: [{ type: 'PROFILE', id: '112233445566778899' }] } }),
		})

		const res = await callback(state, nonce)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`${FRONTEND_URL}/${ws.id}/settings/integrations`)

		const rows = await driveRows(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('active')
		// postInstall opened the changes.watch channel and seeded the cursor.
		expect((rows[0].config as { drive?: Record<string, unknown> }).drive).toMatchObject({
			peopleId: '112233445566778899',
			channelId: expect.any(String),
			channelResourceId: 'resource-1',
			channelExpiresAt: expect.any(Number),
			channelWebhookToken: expect.any(String),
			startPageToken: 'start-1',
		})

		expect(connectedCalls()).toEqual([
			[
				'integration_connected',
				actorId,
				{
					provider: 'google-drive',
					workspace_id: ws.id,
					actor_id: actorId,
					integration_id: rows[0].id,
					auth_type: 'oauth',
					is_backfill: false,
				},
			],
		])
	})

	it('emits nothing when postInstall fails and the connect ends in error', async () => {
		const { ws, nonce, state } = await seedPendingConnect()
		stubGoogle({ people: () => json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, 403) })

		const res = await callback(state, nonce)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(
			`${FRONTEND_URL}/${ws.id}/settings/integrations?error=post_install_failed`,
		)

		const rows = await driveRows(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('error')

		expect(connectedCalls()).toHaveLength(0)
	})

	it('emits nothing when Google refuses the notification channel and the connect ends in error', async () => {
		const { ws, nonce, state } = await seedPendingConnect()
		stubGoogle({
			people: () =>
				json({ metadata: { sources: [{ type: 'PROFILE', id: '112233445566778899' }] } }),
			watch: () => json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, 400),
		})

		const res = await callback(state, nonce)

		expect(res.headers.get('location')).toBe(
			`${FRONTEND_URL}/${ws.id}/settings/integrations?error=post_install_failed`,
		)
		expect((await driveRows(ws.id))[0]?.status).toBe('error')
		expect(connectedCalls()).toHaveLength(0)
	})
})
