import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { getProvider } from '../../lib/integrations/registry'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: googleDisconnectRoutes } = await import(
	'../../routes/integrations-google-disconnect'
)
const { default: integrationsRoutes } = await import('../../routes/integrations')

const GOOGLE_PROVIDERS = ['gmail', 'google-calendar', 'google-meet', 'google-drive'] as const
const EMAIL = 'kai@example.com'

function buildApp() {
	return createIntegrationApp(
		{ path: '/api/integrations/google', module: googleDisconnectRoutes },
		{ path: '/api/integrations', module: integrationsRoutes },
	)
}

function post(workspaceId: string, body: unknown) {
	return new Request('http://localhost/api/integrations/google/disconnect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
		body: JSON.stringify(body),
	})
}

/** One Google row per provider for a human, each with its own refresh token so a
 *  revoke call can be tied back to the row it came from. */
async function seedGoogleRows(
	workspaceId: string,
	email = EMAIL,
	providers: readonly string[] = GOOGLE_PROVIDERS,
) {
	for (const provider of providers) {
		await db.insert(integrations).values({
			workspaceId,
			provider,
			status: 'active',
			externalId: email,
			credentials: encrypt(
				JSON.stringify({
					accessToken: `at-${provider}-${workspaceId}`,
					refreshToken: `rt-${provider}-${workspaceId}`,
				}),
			),
			createdBy: getTestActorId(),
		})
	}
}

async function statusByProvider(workspaceId: string) {
	const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, workspaceId))
	return Object.fromEntries(rows.map((r) => [r.provider, r.status]))
}

/** Replaces each Google provider's preDisconnect with a recorder so a test can see
 *  which rows ran the hook, in what order, and with which decrypted credentials. */
function recordPreDisconnect() {
	const calls: {
		provider: string
		externalId: string | null | undefined
		refreshToken?: string
	}[] = []
	for (const name of GOOGLE_PROVIDERS) {
		const provider = getProvider(name)
		vi.spyOn(provider, 'preDisconnect').mockImplementation(async (ctx) => {
			calls.push({
				provider: name,
				externalId: ctx.externalId,
				refreshToken: ctx.credentials.refreshToken,
			})
		})
	}
	return calls
}

describe('POST /api/integrations/google/disconnect', () => {
	afterEach(() => vi.restoreAllMocks())

	it('drive: revokes only the Drive row and keeps Gmail, Calendar and Meet', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id)
		const calls = recordPreDisconnect()

		const res = await buildApp().request(post(ws.id, { email: EMAIL, scope: 'drive' }))

		expect(res.status).toBe(200)
		expect(await statusByProvider(ws.id)).toEqual({
			gmail: 'active',
			'google-calendar': 'active',
			'google-meet': 'active',
			'google-drive': 'revoked',
		})
		expect(calls.map((c) => c.provider)).toEqual(['google-drive'])
		expect(calls[0]?.refreshToken).toBe(`rt-google-drive-${ws.id}`)
	})

	it('drive-meet: revokes Drive and Meet and keeps Gmail and Calendar', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id)
		const calls = recordPreDisconnect()

		const res = await buildApp().request(post(ws.id, { email: EMAIL, scope: 'drive-meet' }))

		expect(res.status).toBe(200)
		expect(await statusByProvider(ws.id)).toEqual({
			gmail: 'active',
			'google-calendar': 'active',
			'google-meet': 'revoked',
			'google-drive': 'revoked',
		})
		expect(calls.map((c) => c.provider).sort()).toEqual(['google-drive', 'google-meet'])
	})

	it('google: revokes all four rows, each through its own preDisconnect', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id)
		const calls = recordPreDisconnect()

		const res = await buildApp().request(post(ws.id, { email: EMAIL, scope: 'google' }))

		expect(res.status).toBe(200)
		const body = (await res.json()) as { disconnected: { provider: string }[] }
		expect(body.disconnected.map((d) => d.provider).sort()).toEqual([...GOOGLE_PROVIDERS].sort())
		expect(Object.values(await statusByProvider(ws.id))).toEqual([
			'revoked',
			'revoked',
			'revoked',
			'revoked',
		])
		expect(calls.map((c) => c.provider).sort()).toEqual([...GOOGLE_PROVIDERS].sort())
		for (const call of calls) expect(call.refreshToken).toBe(`rt-${call.provider}-${ws.id}`)
	})

	it('runs the real Drive revoke against Google with that row refresh token', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id)
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }))

		const res = await buildApp().request(post(ws.id, { email: EMAIL, scope: 'drive' }))

		expect(res.status).toBe(200)
		const revokeCalls = fetchSpy.mock.calls.filter(([url]) =>
			String(url).includes('oauth2.googleapis.com/revoke'),
		)
		expect(revokeCalls).toHaveLength(1)
		expect(String(revokeCalls[0]?.[1]?.body)).toContain(`token=rt-google-drive-${ws.id}`)
	})

	it('skips a provider the human has no row for without erroring', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id, EMAIL, ['gmail', 'google-drive'])
		recordPreDisconnect()

		const res = await buildApp().request(post(ws.id, { email: EMAIL, scope: 'google' }))

		expect(res.status).toBe(200)
		expect(await statusByProvider(ws.id)).toEqual({ gmail: 'revoked', 'google-drive': 'revoked' })
	})

	it('matches the email case-insensitively and leaves other humans alone', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id, 'Kai@Example.com', ['google-drive'])
		await seedGoogleRows(ws.id, 'priya@example.com', ['google-drive'])
		recordPreDisconnect()

		const res = await buildApp().request(post(ws.id, { email: EMAIL, scope: 'drive' }))

		expect(res.status).toBe(200)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(Object.fromEntries(rows.map((r) => [r.externalId, r.status]))).toEqual({
			'Kai@Example.com': 'revoked',
			'priya@example.com': 'active',
		})
	})

	it('cannot touch rows in another workspace', async () => {
		const owner = await insertWorkspace(db, getTestActorId())
		const other = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(owner.id)
		const calls = recordPreDisconnect()

		const res = await buildApp().request(post(other.id, { email: EMAIL, scope: 'google' }))

		expect(res.status).toBe(404)
		expect(calls).toEqual([])
		expect(Object.values(await statusByProvider(owner.id))).toEqual([
			'active',
			'active',
			'active',
			'active',
		])
	})

	it('404s when the human has nothing connected, and does not re-run an already revoked row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id, EMAIL, ['google-drive'])
		await db
			.update(integrations)
			.set({ status: 'revoked' })
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, 'google-drive')))
		const calls = recordPreDisconnect()

		const res = await buildApp().request(post(ws.id, { email: EMAIL, scope: 'drive' }))

		expect(res.status).toBe(404)
		expect(calls).toEqual([])
	})

	it('400s on an unknown scope or a malformed email', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const app = buildApp()
		expect((await app.request(post(ws.id, { email: EMAIL, scope: 'everything' }))).status).toBe(400)
		expect((await app.request(post(ws.id, { email: 'not-an-email', scope: 'drive' }))).status).toBe(
			400,
		)
	})
})

describe('DELETE /api/integrations/:id after the disconnect extraction', () => {
	afterEach(() => vi.restoreAllMocks())

	it('still revokes the row and runs its preDisconnect', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await seedGoogleRows(ws.id, EMAIL, ['google-drive'])
		const calls = recordPreDisconnect()
		const [row] = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))

		const res = await buildApp().request(
			new Request(`http://localhost/api/integrations/${row?.id}`, {
				method: 'DELETE',
				headers: { 'X-Workspace-Id': ws.id },
			}),
		)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })
		expect((await statusByProvider(ws.id))['google-drive']).toBe('revoked')
		expect(calls.map((c) => c.provider)).toEqual(['google-drive'])
	})
})
