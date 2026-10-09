import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, vi } from 'vitest'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt } = await import('../../lib/crypto')

const FRONTEND_URL = 'https://app.test'
const PEOPLE_URL = 'https://people.googleapis.com/v1/people/me?personFields=metadata'

// What Google answered on 2026-09-29 when the People API was switched off in the
// Meet OAuth client's Cloud project (Sentry MASKIN-DEV-11). The project number is
// a placeholder; the status, reason and service are the real ones.
const PEOPLE_API_DISABLED_BODY = {
	error: {
		code: 403,
		message:
			'People API has not been used in project 123456789012 before or it is disabled. Enable it by visiting the Google Cloud console and retry.',
		status: 'PERMISSION_DENIED',
		details: [
			{
				'@type': 'type.googleapis.com/google.rpc.ErrorInfo',
				reason: 'SERVICE_DISABLED',
				domain: 'googleapis.com',
				metadata: { service: 'people.googleapis.com', consumer: 'projects/123456789012' },
			},
		],
	},
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/**
 * Stub Google at the network edge only. The real google-meet provider config,
 * the real generic callback and real Postgres all run; only the four Google
 * hosts the callback talks to are faked. Every other URL fails loudly so a new
 * outbound call can't slip in unnoticed.
 */
function stubGoogle(handlers: { people: () => Response; subscription?: () => Response }) {
	const calls: string[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			calls.push(url)
			if (url === 'https://oauth2.googleapis.com/token') {
				return json({ access_token: 'ya29.test', refresh_token: 'rt', expires_in: 3600 })
			}
			if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
				return json({ email: 'sebk@example.com' })
			}
			if (url === PEOPLE_URL) return handlers.people()
			if (
				url === 'https://workspaceevents.googleapis.com/v1/subscriptions' &&
				handlers.subscription
			) {
				return handlers.subscription()
			}
			throw new Error(`Unexpected outbound fetch in google-meet callback test: ${url}`)
		}),
	)
	return calls
}

async function seedPendingConnect() {
	const actorId = getTestActorId()
	const ws = await insertWorkspace(db, actorId)
	const nonce = randomBytes(16).toString('hex')
	await db.insert(integrations).values({
		workspaceId: ws.id,
		provider: 'google-meet',
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
	return { ws, nonce, state }
}

function callback(state: string, nonce: string) {
	const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
	return app.request(
		`/api/integrations/google-meet/callback?state=${encodeURIComponent(state)}&code=auth-code`,
		{ headers: { cookie: `maskin_oauth_nonce_google-meet=${nonce}` } },
	)
}

async function meetRows(workspaceId: string) {
	return db
		.select()
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'google-meet')))
}

// Regression coverage for the "Meet still shows Connect after OAuth" report
// (task 73406739). Sebk's three connects on 2026-09-29 left three pending rows
// with empty config because the callback exits at the People id step when Google
// answers 403. The settings tile only counts active rows, so the user saw Connect.
describe('GET /api/integrations/google-meet/callback', () => {
	beforeEach(() => {
		vi.stubEnv('GOOGLE_MEET_CLIENT_ID', 'meet-client-id')
		vi.stubEnv('GOOGLE_MEET_CLIENT_SECRET', 'meet-client-secret')
		vi.stubEnv('GOOGLE_MEET_PUBSUB_TOPIC', 'projects/test/topics/meet-push')
		vi.stubEnv('FRONTEND_URL', FRONTEND_URL)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('leaves the row pending and redirects with people_id_fetch_failed when the People API is disabled', async () => {
		const { ws, nonce, state } = await seedPendingConnect()
		const calls = stubGoogle({ people: () => json(PEOPLE_API_DISABLED_BODY, 403) })

		const res = await callback(state, nonce)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(
			`${FRONTEND_URL}/${ws.id}/settings/integrations?error=people_id_fetch_failed`,
		)

		// Not activated: still the one pending row, no People id, no credentials.
		const rows = await meetRows(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('pending')
		expect(rows[0].externalId).toBe(nonce)
		expect(rows[0].config).toEqual({})

		// The connect stopped before postInstall, so no Workspace Events subscription.
		expect(calls.some((u) => u.includes('workspaceevents.googleapis.com'))).toBe(false)
	})

	it('activates the row with config.meet.peopleId set when the People API answers', async () => {
		const { ws, nonce, state } = await seedPendingConnect()
		stubGoogle({
			people: () =>
				json({ metadata: { sources: [{ type: 'PROFILE', id: '112233445566778899' }] } }),
			subscription: () =>
				json({
					name: 'subscriptions/sub-1',
					targetResource: '//cloudidentity.googleapis.com/users/112233445566778899',
					expireTime: '2026-10-13T00:00:00Z',
				}),
		})

		const res = await callback(state, nonce)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`${FRONTEND_URL}/${ws.id}/settings/integrations`)

		const rows = await meetRows(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('active')
		expect(rows[0].externalId).toBe('sebk@example.com')
		expect(rows[0].config).toMatchObject({
			meet: {
				peopleId: '112233445566778899',
				subscriptionName: 'subscriptions/sub-1',
			},
		})
	})
})
