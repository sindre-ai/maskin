import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, vi } from 'vitest'
import { resolveOrigin } from '../../lib/integrations/oauth/origins'
import { decodeState, encodeState } from '../../lib/integrations/oauth/state'
import { listProviders } from '../../lib/integrations/registry'
import { buildIntegration, buildWorkspaceMember } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: integrationsRoutes } = await import('../../routes/integrations')

const wsId = '00000000-0000-0000-0000-000000000001'
const FRONTEND = 'https://app.example.test'

const originalEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
const originalFrontendUrl = process.env.FRONTEND_URL
const originalDriveId = process.env.GOOGLE_DRIVE_CLIENT_ID
const originalDriveSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('hex')
	process.env.FRONTEND_URL = FRONTEND
	process.env.GOOGLE_DRIVE_CLIENT_ID = 'drive-client-id'
	process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'drive-client-secret'
})

afterAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = originalEncryptionKey
	process.env.FRONTEND_URL = originalFrontendUrl
	process.env.GOOGLE_DRIVE_CLIENT_ID = originalDriveId
	process.env.GOOGLE_DRIVE_CLIENT_SECRET = originalDriveSecret
})

function sealedState(nonce: string, extra: Record<string, unknown> = {}, ts = Date.now()) {
	return encodeState({ workspaceId: wsId, actorId: 'test-actor-id', ts, nonce, ...extra })
}

function callbackGet(provider: string, state: string, nonce: string, query = '') {
	return jsonGet(
		`/api/integrations/${provider}/callback?state=${encodeURIComponent(state)}${query}`,
		{ cookie: `maskin_oauth_nonce_${provider}=${nonce}` },
	)
}

function pendingRow(provider: string, nonce: string) {
	return buildIntegration({ workspaceId: wsId, provider, status: 'pending', externalId: nonce })
}

function memberRow() {
	return buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
}

function appWithPendingRow(provider: string, nonce: string) {
	const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
	mockResults.selectQueue = [[pendingRow(provider, nonce)], [memberRow()]]
	return app
}

describe('resolveOrigin', () => {
	it('resolves the drive origin for the drive provider only', () => {
		expect(resolveOrigin('google-drive', 'google-drive')?.path).toBe(
			'/settings/integrations/google-drive',
		)
		expect(resolveOrigin('google-drive', 'google-meet')).toBeUndefined()
	})

	it.each(['', 'nope', '__proto__', 'constructor', 'toString', 42, null, undefined, {}])(
		'misses for %j',
		(key) => {
			expect(resolveOrigin(key, 'google-drive')).toBeUndefined()
		},
	)
})

describe('POST /api/integrations/:provider/connect with origin', () => {
	function connect(provider: string, body?: unknown) {
		const { app } = createTestApp(integrationsRoutes, '/api/integrations')
		return app.request(
			jsonRequest('POST', `/api/integrations/${provider}/connect`, body, {
				'x-workspace-id': wsId,
			}),
		)
	}

	async function stateOf(res: Response) {
		const url = new URL((await res.json()).install_url)
		return decodeState(url.searchParams.get('state') as string)
	}

	it('seals a valid origin into the state', async () => {
		const res = await connect('google-drive', { origin: 'google-drive' })

		expect(res.status).toBe(200)
		expect((await stateOf(res)).origin).toBe('google-drive')
	})

	it('leaves the state without an origin when none is sent', async () => {
		const res = await connect('google-drive', {})

		expect(res.status).toBe(200)
		expect((await stateOf(res)).origin).toBeUndefined()
	})

	it('refuses an unknown origin', async () => {
		expect((await connect('google-drive', { origin: 'somewhere-else' })).status).toBe(400)
	})

	it('refuses a known origin on another provider', async () => {
		expect((await connect('slack', { origin: 'google-drive' })).status).toBe(400)
	})
})

describe('GET /api/integrations/:provider/callback cancel with origin', () => {
	const nonce = 'drive-cancel-nonce'
	const cancel = '&error=access_denied'
	const driveState = () => sealedState(nonce, { origin: 'google-drive' })

	it('redirects a cancel back to the origin page and clears the nonce cookie', async () => {
		const app = appWithPendingRow('google-drive', nonce)

		const res = await app.request(callbackGet('google-drive', driveState(), nonce, cancel))

		expect(res.status).toBe(302)
		expect(res.headers.get('Location')).toBe(
			`${FRONTEND}/${wsId}/settings/integrations/google-drive?oauth=cancelled`,
		)
		const setCookie = res.headers.get('set-cookie') ?? ''
		expect(setCookie).toContain('maskin_oauth_nonce_google-drive=')
		expect(setCookie).toContain('Max-Age=0')
	})

	it('keeps the JSON 400 for an error other than access_denied', async () => {
		const app = appWithPendingRow('google-drive', nonce)

		const res = await app.request(
			callbackGet('google-drive', driveState(), nonce, '&error=admin_policy_enforced'),
		)

		expect(res.status).toBe(400)
		expect((await res.json()).error.message).toContain('Missing authorization code')
	})

	describe('when the provider also returns a code', () => {
		const originalFetch = globalThis.fetch
		afterAll(() => {
			globalThis.fetch = originalFetch
		})

		it('takes the normal path, and a failed exchange stays distinct from a cancel', async () => {
			globalThis.fetch = vi.fn(async () => {
				throw new Error('network down')
			}) as unknown as typeof fetch
			const app = appWithPendingRow('google-drive', nonce)

			const res = await app.request(
				callbackGet('google-drive', driveState(), nonce, `${cancel}&code=abc`),
			)

			expect(res.status).toBe(302)
			const location = res.headers.get('Location') as string
			expect(location).toContain('/settings/integrations?error=token_exchange_failed')
			expect(location).not.toContain('oauth=cancelled')
		})
	})

	it('treats an unknown origin as no origin', async () => {
		const app = appWithPendingRow('google-drive', nonce)

		const res = await app.request(
			callbackGet('google-drive', sealedState(nonce, { origin: 'somewhere-else' }), nonce, cancel),
		)

		expect(res.status).toBe(400)
	})

	it('treats an origin that belongs to another provider as no origin', async () => {
		const app = appWithPendingRow('google-meet', nonce)

		const res = await app.request(callbackGet('google-meet', driveState(), nonce, cancel))

		expect(res.status).toBe(400)
	})

	describe('forged or stale cancels never redirect', () => {
		it('rejects a tampered state', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(callbackGet('google-drive', `${driveState()}x`, nonce, cancel))

			expect(res.status).toBe(400)
		})

		it('rejects an expired state', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')
			const state = sealedState(nonce, { origin: 'google-drive' }, Date.now() - 11 * 60 * 1000)

			const res = await app.request(callbackGet('google-drive', state, nonce, cancel))

			expect(res.status).toBe(400)
		})

		it('rejects a missing or wrong cookie', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const missing = await app.request(
				jsonGet(
					`/api/integrations/google-drive/callback?state=${encodeURIComponent(driveState())}${cancel}`,
				),
			)
			const wrong = await app.request(callbackGet('google-drive', driveState(), 'other', cancel))

			expect(missing.status).toBe(400)
			expect(wrong.status).toBe(400)
		})

		it('rejects a replayed state whose pending row is gone', async () => {
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[]]

			const res = await app.request(callbackGet('google-drive', driveState(), nonce, cancel))

			expect(res.status).toBe(400)
		})

		it('rejects a cancel from a member who has been removed', async () => {
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[pendingRow('google-drive', nonce)], []]

			const res = await app.request(callbackGet('google-drive', driveState(), nonce, cancel))

			expect(res.status).toBe(400)
		})
	})

	it('keeps the JSON 400 on cancel for every OAuth2 provider when the state has no origin', async () => {
		const oauth2 = listProviders().filter((p) => !p.customAuth && p.config.auth.type === 'oauth2')
		expect(oauth2.length).toBeGreaterThan(0)

		for (const { config } of oauth2) {
			const app = appWithPendingRow(config.name, nonce)

			const res = await app.request(callbackGet(config.name, sealedState(nonce), nonce, cancel))

			expect(res.status, config.name).toBe(400)
			expect((await res.json()).error.message, config.name).toContain('Missing authorization code')
		}
	})
})
