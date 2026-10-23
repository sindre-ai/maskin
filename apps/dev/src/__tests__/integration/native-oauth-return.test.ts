import { randomBytes } from 'node:crypto'
import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	return { ...actual, getProvider: vi.fn(actual.getProvider) }
})

const { getProvider } = await import('../../lib/integrations/registry')
const { default: integrationsRoutes } = await import('../../routes/integrations')
const { encodeState } = await import('../../lib/integrations/oauth/state')

const NATIVE = 'maskin://integrations/callback'
const UNIVERSAL = 'https://maskin.io/native/integrations/callback'

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

/**
 * A standard oauth2-shaped provider whose authorize URL echoes `state`, so the
 * test can drive the callback with exactly the state /connect minted.
 */
function registerProvider(opts: { failExchange?: boolean; selection?: boolean } = {}) {
	const name = `native-test-${randomBytes(4).toString('hex')}`
	const provider: ResolvedProvider = {
		config: {
			name,
			displayName: `Native Test ${name}`,
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
		customAuth: {
			getInstallUrl: (state: string) => `http://example.test/auth?state=${state}`,
			handleCallback: async () => {
				if (opts.failExchange) throw new Error('token endpoint said no')
				if (opts.selection) {
					return {
						pending_installation_selection: true,
						installation_choices: [{ installationId: 1, ownerLogin: 'acme' }],
					}
				}
				return { accessToken: 'super-secret-access-token', refreshToken: 'super-secret-refresh' }
			},
			getAccessToken: async () => 'super-secret-access-token',
		},
	}
	vi.mocked(getProvider).mockReturnValue(provider)
	return name
}

function cookieFrom(res: Response): string {
	const raw = res.headers.get('set-cookie') ?? ''
	return raw.split(';')[0] ?? ''
}

async function connect(
	app: ReturnType<typeof buildApp>,
	provider: string,
	workspaceId: string,
	body: Record<string, unknown>,
) {
	return app.request(`/api/integrations/${provider}/connect`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId },
		body: JSON.stringify(body),
	})
}

/** connect (native) -> open the launch URL in the "web-auth browser" -> pull state out of the authorize URL. */
async function startNative(app: ReturnType<typeof buildApp>, provider: string, wsId: string) {
	const res = await connect(app, provider, wsId, { native_return_url: NATIVE })
	expect(res.status).toBe(200)
	const { install_url } = (await res.json()) as { install_url: string }
	const launch = new URL(install_url)
	const launchRes = await app.request(launch.pathname + launch.search)
	const authorize = new URL(launchRes.headers.get('location') ?? '')
	return {
		installUrl: install_url,
		launchRes,
		cookie: cookieFrom(launchRes),
		state: authorize.searchParams.get('state') ?? '',
	}
}

beforeEach(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.FRONTEND_URL = 'http://frontend.test'
})

describe('POST /api/integrations/:provider/connect — native_return_url', () => {
	it.each([
		'https://evil.test/native/integrations/callback',
		'https://maskin.io.evil.test/native/integrations/callback',
		'https://maskin.io@evil.test/native/integrations/callback',
		'https://maskin.io/native/integrations/callback/../../evil',
		'https://maskin.io/native/integrations/callback?next=https://evil.test',
		'maskin://integrations/callback/extra',
		'maskin://evil/callback',
		'javascript:alert(1)',
		'//evil.test',
		'',
	])('refuses %j with 400 and creates no pending row', async (bad) => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const provider = registerProvider()
		const res = await connect(buildApp(), provider, ws.id, { native_return_url: bad })
		expect(res.status).toBe(400)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows.filter((r) => r.provider === provider)).toHaveLength(0)
	})

	it('leaves the web flow untouched when no native return is supplied', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const res = await connect(buildApp(), provider, ws.id, {})
		expect(res.status).toBe(200)
		const { install_url } = (await res.json()) as { install_url: string }
		expect(install_url.startsWith('http://example.test/auth?state=')).toBe(true)
		expect(cookieFrom(res)).toContain('maskin_oauth_nonce_')
	})

	it('hands a native client a launch URL on our origin instead of the provider URL', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const res = await connect(buildApp(), provider, ws.id, { native_return_url: UNIVERSAL })
		expect(res.status).toBe(200)
		const { install_url } = (await res.json()) as { install_url: string }
		expect(install_url).toContain(`/api/integrations/${provider}/native-launch?ticket=`)
	})
})

describe('GET /api/integrations/:provider/native-launch', () => {
	it('sets the state-binding cookie in the launching browser and redirects to the provider', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const { launchRes, cookie } = await startNative(buildApp(), provider, ws.id)
		expect(launchRes.status).toBe(302)
		expect(launchRes.headers.get('location')).toMatch(/^http:\/\/example\.test\/auth\?state=/)
		expect(cookie).toContain(`maskin_oauth_nonce_${provider}=`)
	})

	it('rejects a tampered ticket', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const { installUrl } = await startNative(app, provider, ws.id)
		const ticket = new URL(installUrl).searchParams.get('ticket') ?? ''
		const flipped = `${ticket.slice(0, -2)}${ticket.endsWith('AA') ? 'BB' : 'AA'}`
		const res = await app.request(`/api/integrations/${provider}/native-launch?ticket=${flipped}`)
		expect(res.status).toBe(400)
		expect(res.headers.get('set-cookie')).toBeNull()
	})

	it('rejects a ticket replayed on a different provider path', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const { installUrl } = await startNative(app, provider, ws.id)
		const ticket = new URL(installUrl).searchParams.get('ticket') ?? ''
		const res = await app.request(`/api/integrations/slack/native-launch?ticket=${ticket}`)
		expect(res.status).toBe(400)
	})

	async function mintTicketUrl(app: ReturnType<typeof buildApp>, provider: string, wsId: string) {
		const res = await connect(app, provider, wsId, { native_return_url: NATIVE })
		const { install_url } = (await res.json()) as { install_url: string }
		const u = new URL(install_url)
		return u.pathname + u.search
	}

	it('is single-use: a second open sets no cookie and ends in the app with state_expired', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const path = await mintTicketUrl(app, provider, ws.id)
		const first = await app.request(path)
		expect(first.status).toBe(302)
		expect(first.headers.get('location')).toMatch(/^http:\/\/example\.test\/auth\?state=/)
		const second = await app.request(path)
		expect(second.status).toBe(302)
		expect(second.headers.get('set-cookie')).toBeNull()
		const loc = new URL(second.headers.get('location') ?? '')
		expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(NATIVE)
		expect(loc.searchParams.get('status')).toBe('error')
		expect(loc.searchParams.get('reason')).toBe('state_expired')
		expect(loc.searchParams.get('workspace_id')).toBe(ws.id)
	})

	it('lets exactly one of several concurrent opens win', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const path = await mintTicketUrl(app, provider, ws.id)
		const results = await Promise.all(Array.from({ length: 8 }, () => app.request(path)))
		const winners = results.filter((r) =>
			(r.headers.get('location') ?? '').startsWith('http://example.test/'),
		)
		expect(winners).toHaveLength(1)
		expect(winners[0]?.headers.get('set-cookie')).toContain('maskin_oauth_nonce_')
		for (const r of results.filter((x) => x !== winners[0])) {
			expect(r.headers.get('set-cookie')).toBeNull()
			expect(r.headers.get('location')).toContain('reason=state_expired')
		}
	})

	it('still completes the callback after the single launch', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const { launchRes, cookie, state } = await startNative(buildApp(), provider, ws.id)
		expect(launchRes.status).toBe(302)
		const res = await buildApp().request(
			`/api/integrations/${provider}/callback?code=abc&state=${state}`,
			{ headers: { cookie } },
		)
		expect(res.headers.get('location')).toContain('status=connected')
	})

	it('rejects a ticket once the pending row is gone', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const { installUrl } = await startNative(app, provider, ws.id)
		await db.delete(integrations).where(eq(integrations.workspaceId, ws.id))
		const u = new URL(installUrl)
		const res = await app.request(u.pathname + u.search)
		expect(res.status).toBe(400)
	})
})

describe('GET /api/integrations/:provider/callback — native return', () => {
	it('redirects to the app with connected + ids, activates the row, logs an event, leaks no token', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const provider = registerProvider()
		const app = buildApp()
		const { state, cookie } = await startNative(app, provider, ws.id)

		const res = await app.request(
			`/api/integrations/${provider}/callback?code=the-auth-code&state=${encodeURIComponent(state)}`,
			{ headers: { cookie } },
		)
		expect(res.status).toBe(302)
		const location = res.headers.get('location') ?? ''
		const url = new URL(location)
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(NATIVE)
		expect(url.searchParams.get('status')).toBe('connected')
		expect(url.searchParams.get('provider')).toBe(provider)
		expect(url.searchParams.get('workspace_id')).toBe(ws.id)

		const [row] = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, provider)))
		expect(row?.status).toBe('active')
		expect(url.searchParams.get('integration_id')).toBe(row?.id)

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'integration'), eq(events.entityId, row?.id ?? '')))
		expect(evs.some((e) => e.action === 'created')).toBe(true)

		for (const secret of ['super-secret', 'the-auth-code', state]) {
			expect(location).not.toContain(secret)
		}
	})

	it('reports not_bound to the app when the browser never got the binding cookie', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const { state } = await startNative(app, provider, ws.id)
		const res = await app.request(
			`/api/integrations/${provider}/callback?code=x&state=${encodeURIComponent(state)}`,
		)
		expect(res.status).toBe(302)
		const url = new URL(res.headers.get('location') ?? '')
		expect(url.searchParams.get('status')).toBe('error')
		expect(url.searchParams.get('reason')).toBe('not_bound')
	})

	it('reports denied when the user declines consent on the provider page', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const { state, cookie } = await startNative(app, provider, ws.id)
		const res = await app.request(
			`/api/integrations/${provider}/callback?error=access_denied&state=${encodeURIComponent(state)}`,
			{ headers: { cookie } },
		)
		const url = new URL(res.headers.get('location') ?? '')
		expect(url.searchParams.get('status')).toBe('error')
		expect(url.searchParams.get('reason')).toBe('denied')
		const [row] = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, provider)))
		expect(row?.status).toBe('pending')
	})

	it('reports token_exchange_failed to the app', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider({ failExchange: true })
		const app = buildApp()
		const { state, cookie } = await startNative(app, provider, ws.id)
		const res = await app.request(
			`/api/integrations/${provider}/callback?code=x&state=${encodeURIComponent(state)}`,
			{ headers: { cookie } },
		)
		const url = new URL(res.headers.get('location') ?? '')
		expect(url.searchParams.get('reason')).toBe('token_exchange_failed')
	})

	it('reports selection_required with the pending integration id when GitHub has several installations', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider({ selection: true })
		const app = buildApp()
		const { state, cookie } = await startNative(app, provider, ws.id)
		const res = await app.request(
			`/api/integrations/${provider}/callback?code=x&state=${encodeURIComponent(state)}`,
			{ headers: { cookie } },
		)
		const url = new URL(res.headers.get('location') ?? '')
		expect(url.searchParams.get('status')).toBe('selection_required')
		const [row] = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, ws.id), eq(integrations.provider, provider)))
		expect(row?.status).toBe('pending')
		expect(url.searchParams.get('integration_id')).toBe(row?.id)
		expect(url.searchParams.get('reason')).toBeNull()
	})

	it('keeps the web redirect when the flow was started without a native return', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const res = await connect(app, provider, ws.id, {})
		const cookie = cookieFrom(res)
		const { install_url } = (await res.json()) as { install_url: string }
		const state = new URL(install_url).searchParams.get('state') ?? ''
		const cb = await app.request(
			`/api/integrations/${provider}/callback?code=x&state=${encodeURIComponent(state)}`,
			{ headers: { cookie } },
		)
		expect(cb.status).toBe(302)
		expect(cb.headers.get('location')).toBe(`http://frontend.test/${ws.id}/settings/integrations`)
	})

	it('keeps the existing JSON error for the web flow when the cookie is missing', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const provider = registerProvider()
		const app = buildApp()
		const res = await connect(app, provider, ws.id, {})
		const { install_url } = (await res.json()) as { install_url: string }
		const state = new URL(install_url).searchParams.get('state') ?? ''
		const cb = await app.request(
			`/api/integrations/${provider}/callback?code=x&state=${encodeURIComponent(state)}`,
		)
		expect(cb.status).toBe(400)
	})

	it('ignores a sealed state whose nativeReturn is not on the allowlist (falls back to web)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const provider = registerProvider()
		const nonce = randomBytes(16).toString('hex')
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
		const state = encodeState({
			workspaceId: ws.id,
			actorId,
			ts: Date.now(),
			nonce,
			nativeReturn: 'https://evil.test/steal',
		})
		const res = await buildApp().request(
			`/api/integrations/${provider}/callback?code=x&state=${encodeURIComponent(state)}`,
			{ headers: { cookie: `maskin_oauth_nonce_${provider}=${nonce}` } },
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`http://frontend.test/${ws.id}/settings/integrations`)
	})
})
