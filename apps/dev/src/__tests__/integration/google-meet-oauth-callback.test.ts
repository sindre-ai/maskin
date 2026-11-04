import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, vi } from 'vitest'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt } = await import('../../lib/crypto')
const { decodeState } = await import('../../lib/integrations/oauth/state')

const FRONTEND_URL = 'https://app.test'

const PEOPLE_ID = '112233445566778899'
const USERINFO_OK = () => json({ id: PEOPLE_ID, email: 'sebk@example.com' })

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/**
 * Stub Google at the network edge only. The real google-meet provider config,
 * the real generic callback and real Postgres all run; only the Google
 * hosts the callback talks to are faked. Every other URL fails loudly so a new
 * outbound call can't slip in unnoticed.
 */
function stubGoogle(handlers: { userinfo: () => Response; subscription?: () => Response }) {
	const calls: string[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			calls.push(url)
			if (url === 'https://oauth2.googleapis.com/token') {
				return json({ access_token: 'ya29.test', refresh_token: 'rt', expires_in: 3600 })
			}
			if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return handlers.userinfo()
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

async function seedPendingConnectIn(workspaceId: string, actorId: string, returnTo?: string) {
	const nonce = randomBytes(16).toString('hex')
	await db.insert(integrations).values({
		workspaceId,
		provider: 'google-meet',
		status: 'pending',
		externalId: nonce,
		credentials: '',
		createdBy: actorId,
	})
	const state = encrypt(
		JSON.stringify({
			workspaceId,
			actorId,
			ts: Date.now(),
			nonce,
			codeVerifier: 'verifier',
			...(returnTo ? { returnTo } : {}),
		}),
	)
	return { nonce, state }
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

	it('leaves the row pending and redirects with people_id_fetch_failed when userinfo has no id', async () => {
		const { ws, nonce, state } = await seedPendingConnect()
		const calls = stubGoogle({ userinfo: () => json({ email: 'sebk@example.com' }) })

		const res = await callback(state, nonce)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(
			`${FRONTEND_URL}/${ws.id}/settings/integrations?error=people_id_fetch_failed`,
		)

		const rows = await meetRows(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('pending')
		expect(rows[0].config).toEqual({})
		expect(calls.some((u) => u.includes('workspaceevents.googleapis.com'))).toBe(false)
	})

	// The prod failure (Sentry MASKIN-DEV-11, 2026-09-29 and again 2026-10-20): the
	// People API is not enabled in the OAuth client's Cloud project, so any call to
	// it is a 403 SERVICE_DISABLED. The stub throws on every host it does not know,
	// so this passes only if the callback never touches people.googleapis.com.
	it('activates the row with config.meet.peopleId taken from userinfo, never calling the People API', async () => {
		const { ws, nonce, state } = await seedPendingConnect()
		const calls = stubGoogle({
			userinfo: USERINFO_OK,
			subscription: () =>
				json({
					name: 'subscriptions/sub-1',
					targetResource: `//cloudidentity.googleapis.com/users/${PEOPLE_ID}`,
					expireTime: '2026-10-13T00:00:00Z',
				}),
		})

		const res = await callback(state, nonce)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`${FRONTEND_URL}/${ws.id}/settings/integrations`)
		expect(calls.some((u) => u.includes('people.googleapis.com'))).toBe(false)

		const rows = await meetRows(ws.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('active')
		expect(rows[0].externalId).toBe('sebk@example.com')
		expect(rows[0].config).toMatchObject({
			meet: { peopleId: PEOPLE_ID, subscriptionName: 'subscriptions/sub-1' },
		})
	})

	// "Land back in the chat where I clicked Connect": the chat path rides inside the
	// sealed OAuth state, so the callback can redirect there instead of Settings.
	describe('return path', () => {
		const MEET_SUBSCRIPTION = () =>
			json({
				name: 'subscriptions/sub-1',
				targetResource: '//cloudidentity.googleapis.com/users/112233445566778899',
				expireTime: '2026-10-13T00:00:00Z',
			})

		it('redirects to the chat the connect started from', async () => {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			const returnTo = `/${ws.id}/chats/22222222-2222-2222-2222-222222222222`
			const seeded = await seedPendingConnectIn(ws.id, actorId, returnTo)
			stubGoogle({ userinfo: USERINFO_OK, subscription: MEET_SUBSCRIPTION })

			const res = await callback(seeded.state, seeded.nonce)

			expect(res.status).toBe(302)
			expect(res.headers.get('location')).toBe(`${FRONTEND_URL}${returnTo}`)
			expect((await meetRows(ws.id))[0].status).toBe('active')
		})

		it('ignores a return path that points into another workspace', async () => {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			const seeded = await seedPendingConnectIn(
				ws.id,
				actorId,
				'/99999999-9999-9999-9999-999999999999/chats/x',
			)
			stubGoogle({ userinfo: USERINFO_OK, subscription: MEET_SUBSCRIPTION })

			const res = await callback(seeded.state, seeded.nonce)

			expect(res.headers.get('location')).toBe(`${FRONTEND_URL}/${ws.id}/settings/integrations`)
		})

		it('seals return_to into the OAuth state when the connect starts', async () => {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			const returnTo = `/${ws.id}/chats/22222222-2222-2222-2222-222222222222`
			const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })

			const res = await app.request('/api/integrations/google-meet/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': ws.id },
				body: JSON.stringify({ return_to: returnTo }),
			})

			expect(res.status).toBe(200)
			const { install_url } = (await res.json()) as { install_url: string }
			const state = new URL(install_url).searchParams.get('state')
			expect(decodeState(state as string).returnTo).toBe(returnTo)
		})

		it('drops a return_to that is not a plain path inside the workspace', async () => {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })

			const res = await app.request('/api/integrations/google-meet/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': ws.id },
				body: JSON.stringify({ return_to: 'https://evil.example/phish' }),
			})

			const { install_url } = (await res.json()) as { install_url: string }
			const state = new URL(install_url).searchParams.get('state')
			expect(decodeState(state as string).returnTo).toBeUndefined()
		})
	})
})
