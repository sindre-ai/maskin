import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// "Install on another organization".
//
// The authorize URL behind "Add another" only lists orgs that already have the
// App, so a user with one installation had no in-app way to add an org without
// it. POST /github/connect with install_new_org returns the App's install page
// instead, carrying the same signed state. GitHub then redirects back with
// installation_id + code, and handleCallback binds it directly.
//
// Run against real Postgres because the pending row minted by connect is what
// the callback's one-time-nonce check reads, and the bind has to refresh that
// row in place rather than trip the partial unique index. GitHub itself is the
// only stub: the token exchange and /user/installations answers are canned.

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')

function newInstallationId(): string {
	return String(Math.floor(Math.random() * 1_000_000_000) + 1)
}

function githubFetchStub(reachable: string[]) {
	return vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		if (url === 'https://github.com/login/oauth/access_token') {
			return new Response(JSON.stringify({ access_token: 'ghu_test' }), { status: 200 })
		}
		if (url.startsWith('https://api.github.com/user/installations')) {
			return new Response(
				JSON.stringify({
					installations: reachable.map((id) => ({
						id: Number(id),
						account: { login: `org-${id}` },
					})),
				}),
				{ status: 200 },
			)
		}
		// fetchInstallationOwnerLogin is best-effort; a failure leaves owner_login unset.
		return new Response('{}', { status: 404 })
	})
}

const { default: integrationsRoutes } = await import('../../routes/integrations')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

describe('GitHub: install on another organization', () => {
	const previous: Record<string, string | undefined> = {}
	const ENV = {
		INTEGRATION_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
		GITHUB_CLIENT_ID: 'Iv1.testclientid',
		GITHUB_CLIENT_SECRET: 'test-client-secret',
		GITHUB_APP_SLUG: 'sindre-maskin',
		FRONTEND_URL: 'http://frontend.test',
	}

	beforeAll(() => {
		for (const [key, value] of Object.entries(ENV)) {
			previous[key] = process.env[key]
			process.env[key] = value
		}
	})

	afterAll(() => {
		for (const key of Object.keys(ENV)) {
			if (previous[key] === undefined) delete process.env[key]
			else process.env[key] = previous[key]
		}
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	async function connectInstallNewOrg(workspaceId: string) {
		const app = buildApp()
		const res = await app.request(
			new Request('http://localhost/api/integrations/github/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
				body: JSON.stringify({ install_new_org: true }),
			}),
		)
		expect(res.status).toBe(200)
		const { install_url } = (await res.json()) as { install_url: string }
		const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
		return { app, installUrl: new URL(install_url), cookie }
	}

	it('returns the App install page and mints a pending row for the signed state', async () => {
		const workspaceId = (await insertWorkspace(db, getTestActorId())).id

		const { installUrl, cookie } = await connectInstallNewOrg(workspaceId)

		expect(`${installUrl.origin}${installUrl.pathname}`).toBe(
			'https://github.com/apps/sindre-maskin/installations/new',
		)
		expect(installUrl.searchParams.get('state')).toBeTruthy()
		expect(cookie).toMatch(/^maskin_oauth_nonce_github=[0-9a-f]{32}$/)

		const pending = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'github')))
		expect(pending).toHaveLength(1)
		expect(pending[0]?.status).toBe('pending')
		expect(cookie.endsWith(pending[0]?.externalId ?? 'missing')).toBe(true)
	})

	it('binds the new org from the post-install callback with no hand-typed URL', async () => {
		const workspaceId = (await insertWorkspace(db, getTestActorId())).id
		const existing = newInstallationId()
		const fresh = newInstallationId()

		// The user already reaches one org; the one they just installed on is new.
		vi.stubGlobal('fetch', githubFetchStub([existing, fresh]))

		const { app, installUrl, cookie } = await connectInstallNewOrg(workspaceId)

		// What GitHub sends the browser back with after the install completes.
		const state = installUrl.searchParams.get('state') ?? ''
		const callback = await app.request(
			new Request(
				`http://localhost/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=abc&installation_id=${fresh}`,
				{ headers: { Cookie: cookie } },
			),
		)

		// Straight back to settings: no picker, even though two installations are reachable.
		expect(callback.status).toBe(302)
		expect(callback.headers.get('location')).toBe(
			`http://frontend.test/${workspaceId}/settings/integrations`,
		)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'github')))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.status).toBe('active')
		expect(rows[0]?.externalId).toBe(fresh)
	})

	it('refuses an installation id the authenticated GitHub user cannot reach', async () => {
		const workspaceId = (await insertWorkspace(db, getTestActorId())).id
		vi.stubGlobal('fetch', githubFetchStub([newInstallationId()]))

		const { app, installUrl, cookie } = await connectInstallNewOrg(workspaceId)

		const state = installUrl.searchParams.get('state') ?? ''
		const callback = await app.request(
			new Request(
				`http://localhost/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=abc&installation_id=${newInstallationId()}`,
				{ headers: { Cookie: cookie } },
			),
		)

		expect(callback.status).toBe(400)
		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, 'github'),
					eq(integrations.status, 'active'),
				),
			)
		expect(rows).toHaveLength(0)
	})
})
