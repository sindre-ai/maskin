import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, vi } from 'vitest'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encrypt } = await import('../../lib/crypto')

const FRONTEND_URL = 'https://app.test'

const ACCOUNTS = {
	'ya29.first': { id: '100000000000000000001', email: 'company@example.com' },
	'ya29.second': { id: '100000000000000000002', email: 'founder@example.com' },
} as const

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

/**
 * Stub Google at the network edge only: the token exchange hands out the access token the test
 * names, and userinfo answers for whichever account that token belongs to. The real youtube
 * provider config, the real generic callback and real Postgres run. Any other host fails loudly.
 */
function stubGoogle(accessToken: keyof typeof ACCOUNTS) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			if (url === 'https://oauth2.googleapis.com/token') {
				return json({ access_token: accessToken, refresh_token: 'rt', expires_in: 3600 })
			}
			if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
				const auth = new Headers(init?.headers).get('authorization')
				const account = ACCOUNTS[String(auth).replace('Bearer ', '') as keyof typeof ACCOUNTS]
				return account ? json(account) : json({}, 401)
			}
			throw new Error(`Unexpected outbound fetch in youtube callback test: ${url}`)
		}),
	)
}

async function seedPendingConnect(workspaceId: string, actorId: string) {
	const nonce = randomBytes(16).toString('hex')
	await db.insert(integrations).values({
		workspaceId,
		provider: 'youtube',
		status: 'pending',
		externalId: nonce,
		credentials: '',
		createdBy: actorId,
	})
	const state = encrypt(
		JSON.stringify({ workspaceId, actorId, ts: Date.now(), nonce, codeVerifier: 'verifier' }),
	)
	return { nonce, state }
}

/** One full connect: a pending row, then the OAuth callback as the given Google account. */
async function connectAs(workspaceId: string, accessToken: keyof typeof ACCOUNTS) {
	const actorId = getTestActorId()
	const { nonce, state } = await seedPendingConnect(workspaceId, actorId)
	stubGoogle(accessToken)
	const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
	return app.request(
		`/api/integrations/youtube/callback?state=${encodeURIComponent(state)}&code=auth-code`,
		{ headers: { cookie: `maskin_oauth_nonce_youtube=${nonce}` } },
	)
}

async function youtubeRows(workspaceId: string) {
	return db
		.select()
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'youtube')))
}

// Smoke S1 of the YouTube bet: the integrations table allows one row per workspace, actor and
// provider unless an external id is set, so every connection must carry the Google account as its
// external id. Otherwise a second connection would replace the first.
describe('GET /api/integrations/youtube/callback: several accounts in one workspace', () => {
	beforeEach(() => {
		vi.stubEnv('GOOGLE_YOUTUBE_CLIENT_ID', 'youtube-client-id')
		vi.stubEnv('GOOGLE_YOUTUBE_CLIENT_SECRET', 'youtube-client-secret')
		vi.stubEnv('FRONTEND_URL', FRONTEND_URL)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('keeps two different Google accounts as two active rows, the first untouched', async () => {
		const ws = await insertWorkspace(db, getTestActorId())

		await connectAs(ws.id, 'ya29.first')
		const [first] = await youtubeRows(ws.id)
		expect(first).toMatchObject({ status: 'active', externalId: 'company@example.com' })

		await connectAs(ws.id, 'ya29.second')
		const rows = await youtubeRows(ws.id)

		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.status === 'active')).toBe(true)
		expect(rows.map((r) => r.externalId).sort()).toEqual([
			'company@example.com',
			'founder@example.com',
		])
		const firstAfter = rows.find((r) => r.id === first.id)
		expect(firstAfter).toMatchObject({
			externalId: 'company@example.com',
			status: 'active',
			credentials: first.credentials,
		})
	})

	it('reconnecting the same account refreshes its own row and adds no second one', async () => {
		const ws = await insertWorkspace(db, getTestActorId())

		await connectAs(ws.id, 'ya29.first')
		const [first] = await youtubeRows(ws.id)
		await connectAs(ws.id, 'ya29.first')
		const rows = await youtubeRows(ws.id)

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			id: first.id,
			status: 'active',
			externalId: 'company@example.com',
		})
	})
})
