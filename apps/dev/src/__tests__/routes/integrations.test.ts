import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, vi } from 'vitest'
import { ProviderUnreachableError } from '../../lib/integrations/errors'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { buildIntegration, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	// Default behavior delegates to the real registry so the rest of this file's
	// tests keep hitting the real provider configs. Per-test mockReturnValueOnce
	// swaps in a substitute when needed.
	return {
		...actual,
		getProvider: vi.fn(actual.getProvider),
		listProviders: vi.fn(actual.listProviders),
	}
})

// Stub fetchInstallationOwnerLogin so the github callback path doesn't make a
// live api.github.com call during unit tests. Keep `githubAuth` as-is so the
// registry's customAuth handler still works.
vi.mock('../../lib/integrations/providers/github/auth', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/github/auth')
	>('../../lib/integrations/providers/github/auth')
	return {
		...actual,
		fetchInstallationOwnerLogin: vi.fn(async (installationId: string) => `owner-${installationId}`),
	}
})

const { getProvider } = await import('../../lib/integrations/registry')
const { default: integrationsRoutes, webhookApp } = await import('../../routes/integrations')
const { fetchInstallationOwnerLogin } = await import('../../lib/integrations/providers/github/auth')

const wsId = '00000000-0000-0000-0000-000000000001'

// Set up encryption key for crypto operations used in connect/callback
const originalEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
const testEncryptionKey = randomBytes(32).toString('hex')

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = testEncryptionKey
})

afterAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = originalEncryptionKey
})

describe('Integrations Routes', () => {
	describe('GET /api/integrations', () => {
		it('returns 200 with list of integrations', async () => {
			const int1 = buildIntegration({ workspaceId: wsId })
			const int2 = buildIntegration({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [int1, int2]

			const res = await app.request(jsonGet('/api/integrations', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			// Credentials should be stripped
			for (const item of body) {
				expect(item).not.toHaveProperty('credentials')
			}
		})
	})

	describe('GET /api/integrations/providers', () => {
		it('returns 200 with list of providers', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(jsonGet('/api/integrations/providers'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
			// At least github provider should be registered
			expect(body.length).toBeGreaterThanOrEqual(1)
			expect(body[0]).toHaveProperty('name')
			expect(body[0]).toHaveProperty('displayName')
			expect(body[0]).toHaveProperty('events')
		})

		// A provider whose mcp.autoInject is false gives an agent no tools until
		// its server spec is attached per-agent. That spec used to exist only as
		// a frontend constant, so an agent driving Maskin over MCP could connect
		// the OAuth integration and had no way to discover it had any tools —
		// "connected, but zero mcp__*ubersuggest* tools exposed".
		it('exposes each provider MCP surface so non-browser clients can discover it', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(jsonGet('/api/integrations/providers'))
			const body = (await res.json()) as Array<{
				name: string
				mcp?: { envKey: string; autoInject: boolean; server?: Record<string, unknown> }
			}>

			const ubersuggest = body.find((p) => p.name === 'ubersuggest')
			expect(ubersuggest?.mcp).toEqual({
				envKey: 'UBERSUGGEST_TOKEN',
				autoInject: false,
				server: {
					type: 'http',
					url: 'https://ubersuggest-mcp.neilpatelapi.com/mcp',
					headers: { Authorization: 'Bearer ${UBERSUGGEST_TOKEN}' },
				},
			})
		})

		it('reports autoInject true for workspace-level providers', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(jsonGet('/api/integrations/providers'))
			const body = (await res.json()) as Array<{ name: string; mcp?: { autoInject: boolean } }>

			expect(body.find((p) => p.name === 'posthog')?.mcp?.autoInject).toBe(true)
		})

		// Guards the gap this whole endpoint change exists to close: a provider
		// that declares mcp but no server is undiscoverable to every client that
		// isn't the web UI, and fails as silence rather than as an error.
		it('gives every MCP-capable provider a paste-ready server spec', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(jsonGet('/api/integrations/providers'))
			const body = (await res.json()) as Array<{
				name: string
				mcp?: { server?: unknown }
			}>

			const missing = body.filter((p) => p.mcp && !p.mcp.server).map((p) => p.name)
			expect(missing).toEqual([])
		})
	})

	describe('POST /api/integrations/:provider/connect', () => {
		it('returns 400 for unknown provider', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/nonexistent/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Unknown provider')
		})

		// GitHub connect now goes through user authorization rather than the App
		// install page, so it needs the App's OAuth client id. Missing config is a
		// deliberate 500 (a server misconfiguration, not a retryable fault), which
		// is why this test has to supply it.
		it('returns 200 with install_url for a known provider', async () => {
			const previousClientId = process.env.GITHUB_CLIENT_ID
			process.env.GITHUB_CLIENT_ID = 'Iv1.testclientid'
			try {
				const { app } = createTestApp(integrationsRoutes, '/api/integrations')

				const res = await app.request(
					jsonRequest('POST', '/api/integrations/github/connect', undefined, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body.install_url).toBeDefined()
				expect(body.install_url).toContain('github.com/login/oauth/authorize')
			} finally {
				process.env.GITHUB_CLIENT_ID = previousClientId
			}
		})

		it('returns 500 when the GitHub App OAuth client id is not configured', async () => {
			const previousClientId = process.env.GITHUB_CLIENT_ID
			process.env.GITHUB_CLIENT_ID = undefined
			// biome-ignore lint/performance/noDelete: must be absent, not the string "undefined"
			delete process.env.GITHUB_CLIENT_ID
			try {
				const { app } = createTestApp(integrationsRoutes, '/api/integrations')

				const res = await app.request(
					jsonRequest('POST', '/api/integrations/github/connect', undefined, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(500)
			} finally {
				process.env.GITHUB_CLIENT_ID = previousClientId
			}
		})

		it('hands the custom auth handler the redirect URI the callback will be served from', async () => {
			const seen: string[] = []
			vi.mocked(getProvider).mockReturnValueOnce({
				config: { name: 'custom-provider', displayName: 'Custom', auth: { type: 'oauth2_custom' } },
				customAuth: {
					getInstallUrl: (_state: string, redirectUri: string) => {
						seen.push(redirectUri)
						return 'http://example.test/auth'
					},
					handleCallback: async () => ({ accessToken: 'token' }),
					getAccessToken: async () => 'token',
				},
			} as unknown as ResolvedProvider)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/custom-provider/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			expect(seen[0]).toContain('/api/integrations/custom-provider/callback')
		})

		// The other half of the browser binding the callback enforces. Emitted here
		// so a forwarded authorize URL cannot be completed by anyone else.
		it('sets an HttpOnly nonce cookie that binds the state to this browser', async () => {
			let issuedState = ''
			vi.mocked(getProvider).mockReturnValueOnce({
				config: { name: 'custom-provider', displayName: 'Custom', auth: { type: 'oauth2_custom' } },
				customAuth: {
					getInstallUrl: (state: string) => {
						issuedState = state
						return 'http://example.test/auth'
					},
					handleCallback: async () => ({ accessToken: 'token' }),
					getAccessToken: async () => 'token',
				},
			} as unknown as ResolvedProvider)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/custom-provider/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const setCookieHeader = res.headers.get('Set-Cookie') ?? ''
			expect(setCookieHeader).toContain('maskin_oauth_nonce_custom-provider=')
			expect(setCookieHeader).toContain('HttpOnly')
			// Lax, not Strict: the callback arrives as a top-level GET navigation from
			// the provider's domain, which Strict would drop.
			expect(setCookieHeader).toContain('SameSite=Lax')

			// The cookie must carry the same nonce that is sealed into the state.
			const { decodeState } = await import('../../lib/integrations/oauth/state')
			const cookieNonce = /maskin_oauth_nonce_custom-provider=([^;]+)/.exec(setCookieHeader)?.[1]
			expect(cookieNonce).toBe(decodeState(issuedState).nonce)
		})

		it('returns 502 when a custom auth handler cannot reach the provider', async () => {
			// Ubersuggest registers an OAuth client (RFC 7591) inside getInstallUrl, so
			// a provider outage surfaces here. It must not escape as an opaque 500.
			vi.mocked(getProvider).mockReturnValueOnce({
				config: { name: 'custom-provider', displayName: 'Custom', auth: { type: 'oauth2_custom' } },
				customAuth: {
					getInstallUrl: async () => {
						throw new ProviderUnreachableError('client registration failed: 503')
					},
					handleCallback: async () => ({ accessToken: 'token' }),
					getAccessToken: async () => 'token',
				},
			} as unknown as ResolvedProvider)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/custom-provider/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(502)
			const body = await res.json()
			expect(body.error.message).toContain('Custom')
			expect(body.error.message).toContain('try again')
		})

		it('returns 500, not 502, when the handler fails for a local reason', async () => {
			// A missing INTEGRATION_ENCRYPTION_KEY or a malformed state envelope is a
			// server misconfiguration. Reporting it as "provider unreachable, please
			// try again" sends the user into a retry loop that can never succeed and
			// hides the real fault from whoever has to fix it.
			vi.mocked(getProvider).mockReturnValueOnce({
				config: { name: 'custom-provider', displayName: 'Custom', auth: { type: 'oauth2_custom' } },
				customAuth: {
					getInstallUrl: async () => {
						throw new Error('INTEGRATION_ENCRYPTION_KEY environment variable is required')
					},
					handleCallback: async () => ({ accessToken: 'token' }),
					getAccessToken: async () => 'token',
				},
			} as unknown as ResolvedProvider)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/custom-provider/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.message).toContain('misconfiguration')
			// The operator-facing detail must not leak to the caller.
			expect(body.error.message).not.toContain('INTEGRATION_ENCRYPTION_KEY')
		})

		it('activates an api_key provider (posthog) immediately and stores the request key in credentials', async () => {
			const originalFrontendUrl = process.env.FRONTEND_URL
			process.env.FRONTEND_URL = 'http://localhost:5173'
			try {
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.insert = [{ id: '11111111-1111-1111-1111-111111111111' }]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/integrations/posthog/connect',
						{ api_key: 'phx_test_personal_key' },
						{
							'x-workspace-id': wsId,
						},
					),
				)

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body.install_url).toBe(`http://localhost:5173/${wsId}/settings/integrations`)

				const integrationInsert = calls.inserts[0] as Record<string, unknown>
				expect(integrationInsert.provider).toBe('posthog')
				expect(integrationInsert.status).toBe('active')
				expect(integrationInsert.externalId).toBe('posthog-personal')
				expect(typeof integrationInsert.credentials).toBe('string')
				expect((integrationInsert.credentials as string).length).toBeGreaterThan(0)
				// Credentials must be encrypted, not the plain request value
				expect(integrationInsert.credentials).not.toBe('phx_test_personal_key')

				const eventInsert = calls.inserts[1] as Record<string, unknown>
				expect(eventInsert.entityType).toBe('integration')
				expect(eventInsert.action).toBe('created')
				expect((eventInsert.data as Record<string, unknown>).provider).toBe('posthog')
				expect((eventInsert.data as Record<string, unknown>).auth_type).toBe('api_key')
			} finally {
				if (originalFrontendUrl === undefined) {
					Reflect.deleteProperty(process.env, 'FRONTEND_URL')
				} else {
					process.env.FRONTEND_URL = originalFrontendUrl
				}
			}
		})

		it('refreshes an existing active api_key integration instead of inserting a duplicate', async () => {
			try {
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.selectQueue = [[{ id: 'existing-integration-id' }]]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/integrations/posthog/connect',
						{ api_key: 'phx_test_personal_key' },
						{
							'x-workspace-id': wsId,
						},
					),
				)

				expect(res.status).toBe(200)
				expect(calls.inserts.length).toBeGreaterThanOrEqual(1)
				expect(
					calls.inserts.find(
						(entry: Record<string, unknown>) =>
							entry.action === 'created' &&
							entry.entityType === 'integration' &&
							(entry.data as Record<string, unknown>)?.provider === 'posthog',
					),
				).toMatchObject({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					action: 'created',
					entityType: 'integration',
					data: {
						provider: 'posthog',
						external_id: 'posthog-personal',
						auth_type: 'api_key',
					},
				})
			} finally {
				// No env state to restore for PostHog anymore.
			}
		})

		it('returns 400 when api_key provider request body is missing', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonRequest('POST', '/api/integrations/posthog/connect', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('requires an API key')
		})

		it('returns 200 with install_url for standard oauth2 provider (slack)', async () => {
			const originalClientId = process.env.SLACK_CLIENT_ID
			process.env.SLACK_CLIENT_ID = 'test-slack-client-id'
			try {
				const { app } = createTestApp(integrationsRoutes, '/api/integrations')

				const res = await app.request(
					jsonRequest('POST', '/api/integrations/slack/connect', undefined, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body.install_url).toBeDefined()
				expect(body.install_url).toContain('slack.com/oauth')
				expect(body.install_url).toContain('response_type=code')
			} finally {
				if (originalClientId === undefined) {
					Reflect.deleteProperty(process.env, 'SLACK_CLIENT_ID')
				} else {
					process.env.SLACK_CLIENT_ID = originalClientId
				}
			}
		})
	})

	describe('GET /api/integrations/:provider/callback', () => {
		// The callback now requires (a) the state-binding cookie set by POST
		// /:provider/connect, and (b) a real `code` — a bare `installation_id` is
		// unverifiable and is refused. Both are properties of the flow under test,
		// so every case here supplies them.
		const originalFetch = globalThis.fetch
		const originalClientId = process.env.GITHUB_CLIENT_ID
		const originalSecret = process.env.GITHUB_CLIENT_SECRET

		/** Every installation id these tests hand to the callback. */
		const REACHABLE = [42, 99, 123, 200, 300]

		beforeEach(() => {
			process.env.GITHUB_CLIENT_ID = 'Iv1.testclientid'
			process.env.GITHUB_CLIENT_SECRET = 'test-client-secret'
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input)
				if (url.includes('login/oauth/access_token')) {
					return new Response(JSON.stringify({ access_token: 'ghu_usertoken' }), { status: 200 })
				}
				if (url.includes('/user/installations')) {
					return new Response(
						JSON.stringify({
							installations: REACHABLE.map((id) => ({ id, account: { login: `owner-${id}` } })),
						}),
						{ status: 200 },
					)
				}
				throw new Error(`Unexpected fetch: ${url}`)
			}) as unknown as typeof fetch
		})

		afterEach(() => {
			globalThis.fetch = originalFetch
			process.env.GITHUB_CLIENT_ID = originalClientId
			process.env.GITHUB_CLIENT_SECRET = originalSecret
		})

		/** A callback request carrying the binding cookie the connect route sets. */
		function callbackGet(path: string, nonce: string, provider = 'github') {
			return jsonGet(path, { cookie: `maskin_oauth_nonce_${provider}=${nonce}` })
		}

		it('returns 400 for unknown provider', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonGet('/api/integrations/nonexistent/callback?state=abc&code=123'),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Unknown provider')
		})

		it('returns 400 when state parameter is missing', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(jsonGet('/api/integrations/github/callback'))

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Missing state parameter')
		})

		it('returns 400 when state is invalid/corrupt', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonGet('/api/integrations/github/callback?state=invalid-garbage'),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid state parameter')
		})

		it('returns 400 when state is expired', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const expiredState = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now() - 11 * 60 * 1000, // 11 minutes ago
					nonce: 'test-nonce',
				}),
			)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(expiredState)}&code=cb&installation_id=123`,
					'test-nonce',
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('expired')
		})

		it('returns 400 when nonce is already used (replay attack)', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce: 'used-nonce',
				}),
			)
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')
			// No pending integration found with this nonce

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=123`,
					'used-nonce',
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid or already used state token')
		})

		it('returns 400 when actor is no longer a workspace member', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'valid-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			// First select: pending integration found, second select: membership check fails
			mockResults.selectQueue = [[pendingIntegration], []]

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=123`,
					'valid-nonce',
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('no longer a member')
		})

		// The state envelope authorizes whoever presents it, and GitHub's
		// user-authorization endpoint returns with no prompt for anyone who has
		// already approved the App. Without the browser binding, an attacker could
		// hand their own authorize URL to a victim and have the victim's org bound
		// into the attacker's workspace on one click.
		it('returns 400 when the state-binding cookie is absent', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'unbound-nonce'
			const state = encrypt(
				JSON.stringify({ workspaceId: wsId, actorId: 'test-actor-id', ts: Date.now(), nonce }),
			)
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[buildIntegration({ workspaceId: wsId, status: 'pending', externalId: nonce })],
				[buildWorkspaceMember({ workspaceId: wsId, actorId: 'test-actor-id' })],
			]

			const res = await app.request(
				jsonGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=42`,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not started in this browser')
		})

		it('returns 400 when the binding cookie names a different nonce', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'victim-nonce'
			const state = encrypt(
				JSON.stringify({ workspaceId: wsId, actorId: 'test-actor-id', ts: Date.now(), nonce }),
			)
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[buildIntegration({ workspaceId: wsId, status: 'pending', externalId: nonce })],
				[buildWorkspaceMember({ workspaceId: wsId, actorId: 'test-actor-id' })],
			]

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=42`,
					'some-other-flows-nonce',
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not started in this browser')
		})

		// installation_id is a raw query param and every downstream mint uses the
		// App's own JWT, which succeeds for any installation of the App — so it must
		// be checked against what the authenticated user can actually reach.
		it('returns 400 when the callback names an installation the user cannot reach', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'unreachable-nonce'
			const state = encrypt(
				JSON.stringify({ workspaceId: wsId, actorId: 'test-actor-id', ts: Date.now(), nonce }),
			)
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[buildIntegration({ workspaceId: wsId, status: 'pending', externalId: nonce })],
				[buildWorkspaceMember({ workspaceId: wsId, actorId: 'test-actor-id' })],
			]

			const res = await app.request(
				callbackGet(
					// 999 is not in REACHABLE, so /user/installations does not list it.
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=999`,
					nonce,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not one your GitHub account can access')
		})

		it('completes callback flow and redirects for github provider', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'cb-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
			]

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=42`,
					'cb-nonce',
				),
			)

			// Should redirect to frontend
			expect(res.status).toBe(302)
			const location = res.headers.get('Location')
			expect(location).toContain('/settings/integrations')
		})

		it('creates system actor when none exists and adds as workspace member', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'new-actor-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const newSystemActor = { id: 'new-system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[], // system actor lookup — not found
				[], // existing member check — not found (will insert)
			]
			mockResults.insert = [newSystemActor] // insert new system actor

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=99`,
					'new-actor-nonce',
				),
			)

			expect(res.status).toBe(302)
			const location = res.headers.get('Location')
			expect(location).toContain('/settings/integrations')
		})

		it('returns 400 when missing authorization code for oauth2 provider (slack)', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'slack-no-code'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
			]

			// No code query parameter
			const res = await app.request(
				callbackGet(
					`/api/integrations/slack/callback?state=${encodeURIComponent(state)}`,
					'slack-no-code',
					'slack',
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Missing authorization code')
		})

		it('redirects with error when token exchange fails for oauth2 provider', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const originalClientId = process.env.SLACK_CLIENT_ID
			const originalClientSecret = process.env.SLACK_CLIENT_SECRET
			process.env.SLACK_CLIENT_ID = 'test-slack-id'
			process.env.SLACK_CLIENT_SECRET = 'test-slack-secret'

			try {
				const nonce = 'slack-token-fail'
				const state = encrypt(
					JSON.stringify({
						workspaceId: wsId,
						actorId: 'test-actor-id',
						ts: Date.now(),
						nonce,
					}),
				)
				const pendingIntegration = buildIntegration({
					workspaceId: wsId,
					provider: 'slack',
					status: 'pending',
					externalId: nonce,
				})
				const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
				const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.selectQueue = [
					[pendingIntegration], // pending integration lookup
					[member], // membership check
				]

				// The code=invalid will cause the token exchange to fail (network error to slack.com)
				const res = await app.request(
					callbackGet(
						`/api/integrations/slack/callback?state=${encodeURIComponent(state)}&code=invalid-code`,
						'slack-token-fail',
						'slack',
					),
				)

				// Should redirect with error param
				expect(res.status).toBe(302)
				const location = res.headers.get('Location')
				expect(location).toContain('error=token_exchange_failed')
			} finally {
				if (originalClientId === undefined) {
					Reflect.deleteProperty(process.env, 'SLACK_CLIENT_ID')
				} else {
					process.env.SLACK_CLIENT_ID = originalClientId
				}
				if (originalClientSecret === undefined) {
					Reflect.deleteProperty(process.env, 'SLACK_CLIENT_SECRET')
				} else {
					process.env.SLACK_CLIENT_SECRET = originalClientSecret
				}
			}
		})

		it('uses installation_id as external ID and persists config.owner_login in github callback', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'fallback-nonce-1234567890'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
				[], // existing-active-row lookup — first time seeing this installation
			]

			// GitHub callback with installation_id — uses installation_id as externalId
			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=42`,
					'fallback-nonce-1234567890',
				),
			)

			expect(res.status).toBe(302)
			expect(fetchInstallationOwnerLogin).toHaveBeenCalledWith('42')

			const activateCall = calls.updates.find(
				(u): u is { status?: string; externalId?: string; config?: { owner_login?: string } } =>
					!!u && typeof u === 'object' && (u as { status?: string }).status === 'active',
			)
			expect(activateCall).toBeDefined()
			expect(activateCall?.externalId).toBe('42')
			expect(activateCall?.config).toEqual({
				system_actor_id: 'system-actor-id',
				owner_login: 'owner-42',
			})
		})

		it('connecting a second github installation creates a new row and leaves the first untouched', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'second-install-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup (the row for THIS connect)
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
				// existing-active-row lookup for installation_id=200 — empty because the
				// already-connected installation_id=100 doesn't match this externalId
				[],
			]

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=200`,
					'second-install-nonce',
				),
			)

			expect(res.status).toBe(302)

			// Exactly one update — the pending row activates as a NEW active row.
			// Crucially: nothing else got UPDATE'd (the first installation row, if it
			// existed, would have its own externalId=100 and the WHERE clause never
			// matches it).
			const activateCalls = calls.updates.filter(
				(u) => u && typeof u === 'object' && (u as { status?: string }).status === 'active',
			)
			expect(activateCalls).toHaveLength(1)
			expect(activateCalls[0]).toMatchObject({
				status: 'active',
				externalId: '200',
				config: { system_actor_id: 'system-actor-id', owner_login: 'owner-200' },
			})

			// No refresh-shaped update (no status field set) — the existing row was untouched.
			const refreshCalls = calls.updates.filter(
				(u) =>
					u &&
					typeof u === 'object' &&
					!('status' in (u as Record<string, unknown>)) &&
					'credentials' in (u as Record<string, unknown>),
			)
			expect(refreshCalls).toHaveLength(0)
		})

		it('re-connecting the same github installation refreshes the existing row in place (no duplicate)', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'reconnect-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				status: 'pending',
				externalId: nonce,
			})
			const existingActive = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				status: 'active',
				externalId: '300',
				config: { system_actor_id: 'system-actor-id', owner_login: 'owner-300' },
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'GitHub' }
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
				[existingActive], // existing-active-row lookup — finds the already-active installation
			]

			const res = await app.request(
				callbackGet(
					`/api/integrations/github/callback?state=${encodeURIComponent(state)}&code=cb&installation_id=300`,
					'reconnect-nonce',
				),
			)

			expect(res.status).toBe(302)

			// Refresh-shaped update: re-activates the existing row with fresh
			// credentials + config but does NOT set externalId — that's how it
			// differs from promoting the pending row, which rewrites externalId.
			// (status IS set since the refresh branch also revives revoked rows.)
			const refreshCall = calls.updates.find(
				(u) =>
					u &&
					typeof u === 'object' &&
					'credentials' in (u as Record<string, unknown>) &&
					!('externalId' in (u as Record<string, unknown>)),
			) as { status?: string; credentials?: string; config?: { owner_login?: string } } | undefined
			expect(refreshCall).toBeDefined()
			expect(refreshCall?.status).toBe('active')
			expect(refreshCall?.config).toEqual({
				system_actor_id: 'system-actor-id',
				owner_login: 'owner-300',
			})

			// No promote-shaped update — the pending row was deleted, not rewritten
			// to the installation's externalId.
			const promoteCalls = calls.updates.filter(
				(u) => u && typeof u === 'object' && 'externalId' in (u as Record<string, unknown>),
			)
			expect(promoteCalls).toHaveLength(0)
		})

		it('re-connecting a resolveExternalId provider (e.g. Google Calendar) refreshes the existing row instead of hitting the unique constraint', async () => {
			// Regression test: resolveExternalId-based providers (Google Calendar's
			// account email) derive a STABLE externalId, same as GitHub's
			// installation_id. Reconnecting must hit the existing-active-row refresh
			// path — not the plain "activate the pending row" path, which would try
			// to UPDATE ... SET external_id = <the same email already in use> and
			// violate the (workspace_id, provider, external_id) unique constraint.
			const providerName = 'test-email-provider'
			const stableEmail = 'magnus@meshfirm.com'

			const testProvider: ResolvedProvider = {
				config: {
					name: providerName,
					displayName: 'Test Email Provider',
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
					getInstallUrl: () => 'http://example.test/auth',
					handleCallback: async () => ({ accessToken: 'test-token' }),
					getAccessToken: async () => 'test-token',
				},
				resolveExternalId: async () => stableEmail,
			}
			vi.mocked(getProvider).mockReturnValueOnce(testProvider)

			const { encrypt } = await import('../../lib/crypto')
			const nonce = 'reconnect-email-nonce'
			const state = encrypt(
				JSON.stringify({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					ts: Date.now(),
					nonce,
				}),
			)
			const pendingIntegration = buildIntegration({
				workspaceId: wsId,
				provider: providerName,
				status: 'pending',
				externalId: nonce,
			})
			const existingActive = buildIntegration({
				workspaceId: wsId,
				provider: providerName,
				status: 'active',
				externalId: stableEmail,
				config: { system_actor_id: 'system-actor-id' },
			})
			const member = buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })
			const systemActor = { id: 'system-actor-id', type: 'system', name: 'Test Email Provider' }
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [
				[pendingIntegration], // pending integration lookup
				[member], // membership check
				[systemActor], // system actor lookup
				[{ workspaceId: wsId, actorId: systemActor.id }], // existing member check
				[existingActive], // existing-active-row lookup — finds the already-active integration by email
			]

			const res = await app.request(
				callbackGet(
					`/api/integrations/${providerName}/callback?state=${encodeURIComponent(state)}`,
					'reconnect-email-nonce',
					providerName,
				),
			)

			expect(res.status).toBe(302)

			// Refresh-shaped update: re-activates the existing row with fresh
			// credentials + config but does NOT set externalId — that's how it
			// differs from promoting the pending row, which rewrites externalId.
			// (status IS set since the refresh branch also revives revoked rows.)
			const refreshCall = calls.updates.find(
				(u) =>
					u &&
					typeof u === 'object' &&
					'credentials' in (u as Record<string, unknown>) &&
					!('externalId' in (u as Record<string, unknown>)),
			) as { status?: string } | undefined
			expect(refreshCall).toBeDefined()
			expect(refreshCall?.status).toBe('active')

			// No promote-shaped update — this is the exact bug: activating the
			// pending row here would set external_id to a value already used by
			// existingActive and violate the unique constraint.
			const promoteCalls = calls.updates.filter(
				(u) => u && typeof u === 'object' && 'externalId' in (u as Record<string, unknown>),
			)
			expect(promoteCalls).toHaveLength(0)
		})
	})

	describe('DELETE /api/integrations/:id', () => {
		it('returns 200 when integration deleted', async () => {
			const integration = buildIntegration({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[integration]]

			const res = await app.request(
				jsonDelete(`/api/integrations/${integration.id}`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when integration not found', async () => {
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')

			const res = await app.request(
				jsonDelete('/api/integrations/00000000-0000-0000-0000-000000000099', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when integration belongs to different workspace (cross-workspace)', async () => {
			const otherWsId = '00000000-0000-0000-0000-000000000002'
			const integration = buildIntegration({ workspaceId: otherWsId })
			const { app } = createTestApp(integrationsRoutes, '/api/integrations')
			// The select query filters by both id AND workspaceId, so it returns empty

			const res = await app.request(
				jsonDelete(`/api/integrations/${integration.id}`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/integrations/:id/complete', () => {
		it('returns 400 when secret is missing from the request body', async () => {
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'skjald',
				status: 'awaiting_secret',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/integrations/${integration.id}/complete`,
					{},
					{
						'x-workspace-id': wsId,
					},
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('secret is required')
		})

		it('returns 400 when secret is blank/whitespace-only', async () => {
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'skjald',
				status: 'awaiting_secret',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/integrations/${integration.id}/complete`,
					{ secret: '   ' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('secret is required')
		})

		it('returns 404 when integration is not found (wrong id/workspace)', async () => {
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [] // id/workspaceId filter matches nothing

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/integrations/00000000-0000-0000-0000-000000000099/complete',
					{ secret: 'sk-test-secret' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
			const body = await res.json()
			expect(body.error.message).toContain('not found')
		})

		it('returns 400 when the provider does not use manual auth', async () => {
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack', // registered provider whose auth.type is 'oauth2', not 'manual'
				status: 'awaiting_secret',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/integrations/${integration.id}/complete`,
					{ secret: 'sk-test-secret' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('does not use manual auth')
		})

		it('returns 400 when the integration is not awaiting a secret', async () => {
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'skjald',
				status: 'active', // already completed — not awaiting_secret
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/integrations/${integration.id}/complete`,
					{ secret: 'sk-test-secret' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not awaiting a secret')
		})

		it('activates the integration when given a valid secret for an awaiting-secret manual-auth provider', async () => {
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'skjald',
				status: 'awaiting_secret',
			})
			const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/integrations/${integration.id}/complete`,
					{ secret: 'sk-test-secret' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual({ activated: true })

			const activateCall = calls.updates.find(
				(u) => u && typeof u === 'object' && (u as { status?: string }).status === 'active',
			) as { status?: string; credentials?: string } | undefined
			expect(activateCall).toBeDefined()
			expect(activateCall?.credentials).not.toBe('sk-test-secret')

			const eventInsert = calls.inserts[0] as
				| { action: string; entityType: string; entityId: string; data: Record<string, unknown> }
				| undefined
			expect(eventInsert).toMatchObject({
				action: 'updated',
				entityType: 'integration',
				entityId: integration.id,
				data: { status: 'active', provider: 'skjald' },
			})
		})
	})

	describe('GET /api/integrations/:id/github-token', () => {
		const { privateKey: testPrivateKeyPem } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		})
		const originalAppId = process.env.GITHUB_APP_ID
		const originalKey = process.env.GITHUB_APP_PRIVATE_KEY

		beforeAll(() => {
			process.env.GITHUB_APP_ID = '12345'
			process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKeyPem
		})

		afterAll(() => {
			process.env.GITHUB_APP_ID = originalAppId
			process.env.GITHUB_APP_PRIVATE_KEY = originalKey
		})

		it('returns a freshly minted token for an active GitHub integration', async () => {
			const { encrypt } = await import('../../lib/crypto')

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				status: 'active',
				credentials: encrypt(JSON.stringify({ installation_id: '42' })),
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(
					new Response(JSON.stringify({ token: 'ghs_fresh_token' }), { status: 200 }),
				)

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/github-token`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual({ token: 'ghs_fresh_token' })
			// Every call mints a new token (no caching) — this route exists precisely
			// so a caller mid-session gets a live token instead of a stale one.
			expect(fetchSpy).toHaveBeenCalledWith(
				'https://api.github.com/app/installations/42/access_tokens',
				expect.objectContaining({ method: 'POST' }),
			)
			fetchSpy.mockRestore()
		})

		it('returns 404 when integration is not GitHub', async () => {
			const integration = buildIntegration({ workspaceId: wsId, provider: 'slack' })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [] // filter on provider='github' returns nothing

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/github-token`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when integration belongs to a different workspace', async () => {
			const integration = buildIntegration({
				workspaceId: 'other-workspace-id',
				provider: 'github',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = []

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/github-token`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when GitHub API rejects the token mint', async () => {
			const { encrypt } = await import('../../lib/crypto')

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'github',
				status: 'active',
				credentials: encrypt(JSON.stringify({ installation_id: '42' })),
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(new Response('Bad credentials', { status: 401 }))

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/github-token`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			fetchSpy.mockRestore()
		})

		describe('installation-id recovery (?repo= + GITHUB_APP_INSTALLATION_RECOVERY_ENABLED)', () => {
			const originalFlag = process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED

			afterEach(() => {
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = originalFlag
			})

			it('ignores ?repo= when the recovery flag is off (legacy path)', async () => {
				const { encrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'false'

				const integration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.select = [integration]

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValue(new Response(JSON.stringify({ token: 'ghs_legacy' }), { status: 200 }))

				const res = await app.request(
					jsonGet(`/api/integrations/${integration.id}/github-token?repo=sindre-ai%2Fmaskin`, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				expect(await res.json()).toEqual({ token: 'ghs_legacy' })
				// Legacy TokenManager path — no discovery call, no credentials rewrite.
				expect(fetchSpy).toHaveBeenCalledTimes(1)
				expect(fetchSpy).toHaveBeenCalledWith(
					'https://api.github.com/app/installations/42/access_tokens',
					expect.objectContaining({ method: 'POST' }),
				)
				fetchSpy.mockRestore()
			})

			it('recovers installation id on stale-cache 404 and persists it with an audit event', async () => {
				const { encrypt, decrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'

				const integration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				// Route lookup + guarded re-read inside the recovery transaction.
				mockResults.selectQueue = [[integration], [integration]]

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
					.mockResolvedValueOnce(new Response(JSON.stringify({ id: 9999 }), { status: 200 }))
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ token: 'ghs_recovered' }), { status: 200 }),
					)

				const res = await app.request(
					jsonGet(`/api/integrations/${integration.id}/github-token?repo=sindre-ai%2Fmaskin`, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				expect(await res.json()).toEqual({ token: 'ghs_recovered' })

				// Cached-id mint, discovery, and re-mint against the recovered id.
				expect(fetchSpy).toHaveBeenCalledTimes(3)
				expect(fetchSpy).toHaveBeenNthCalledWith(
					2,
					'https://api.github.com/repos/sindre-ai/maskin/installation',
					expect.any(Object),
				)
				expect(fetchSpy).toHaveBeenNthCalledWith(
					3,
					'https://api.github.com/app/installations/9999/access_tokens',
					expect.objectContaining({ method: 'POST' }),
				)

				// Credentials are rewritten with the recovered install id — the
				// next write from this session skips the recovery round-trip.
				const setCall = calls.updates[0] as { credentials: string } | undefined
				expect(setCall).toBeDefined()
				const rewritten = JSON.parse(decrypt(setCall?.credentials as string))
				expect(rewritten.installation_id).toBe('9999')

				// Audit event names the recovery so ops can grep for it later.
				const insertValues = calls.inserts[0] as
					| {
							action: string
							entityType: string
							data: Record<string, unknown>
					  }
					| undefined
				expect(insertValues).toBeDefined()
				expect(insertValues?.action).toBe('updated')
				expect(insertValues?.entityType).toBe('integration')
				expect(insertValues?.data).toMatchObject({
					reason: 'installation_id_recovered',
					old_installation_id: '42',
					new_installation_id: '9999',
					repo: 'sindre-ai/maskin',
				})

				fetchSpy.mockRestore()
			})

			it('does not rewrite credentials when the cached install id worked on the first try', async () => {
				const { encrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'

				const integration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.select = [integration]

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValue(new Response(JSON.stringify({ token: 'ghs_first' }), { status: 200 }))

				const res = await app.request(
					jsonGet(`/api/integrations/${integration.id}/github-token?repo=sindre-ai%2Fmaskin`, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				expect(await res.json()).toEqual({ token: 'ghs_first' })
				expect(fetchSpy).toHaveBeenCalledTimes(1)
				expect(calls.updates).toHaveLength(0)
				expect(calls.inserts).toHaveLength(0)
				fetchSpy.mockRestore()
			})

			it('rejects a malformed ?repo= slug by falling back to the legacy path', async () => {
				const { encrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'

				const integration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.select = [integration]

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValue(new Response(JSON.stringify({ token: 'ghs_legacy' }), { status: 200 }))

				const res = await app.request(
					jsonGet(
						`/api/integrations/${integration.id}/github-token?repo=${encodeURIComponent(
							'../etc/passwd',
						)}`,
						{ 'x-workspace-id': wsId },
					),
				)

				// Bad slug is ignored, not surfaced as an error — the route
				// still answers with a legacy-path token.
				expect(res.status).toBe(200)
				expect(fetchSpy).toHaveBeenCalledTimes(1)
				expect(fetchSpy).toHaveBeenCalledWith(
					'https://api.github.com/app/installations/42/access_tokens',
					expect.objectContaining({ method: 'POST' }),
				)
				fetchSpy.mockRestore()
			})

			it('returns 400 BAD_REQUEST (NOT AUTH_REVOKED) when discovery 5xxs — transient GitHub outage', async () => {
				// A 5xx from `/repos/:repo/installation` is a GitHub outage / rate
				// limit, not a revoked grant. The route must NOT map it to 401 —
				// telling a caller "please reconnect" when the App is fine is a
				// misclassification the tagger has to work around. The gate keys
				// on DiscoveryError.status === 404, so 500/503/429/etc. drop to
				// the transient BAD_REQUEST branch.
				const { encrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'

				const integration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.select = [integration]

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
					.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))

				const res = await app.request(
					jsonGet(`/api/integrations/${integration.id}/github-token?repo=sindre-ai%2Fmaskin`, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(400)
				const body = (await res.json()) as { error: { code: string } }
				expect(body.error.code).toBe('BAD_REQUEST')
				fetchSpy.mockRestore()
			})

			it('returns 401 AUTH_REVOKED when discovery 404s (App uninstalled entirely)', async () => {
				// Discovery 404 means GitHub has no installation for this repo — the
				// App is gone from the org. Surfacing that as a generic 400 would
				// hide the reconnect prompt from the caller.
				const { encrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'

				const integration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.select = [integration]

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
					.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

				const res = await app.request(
					jsonGet(`/api/integrations/${integration.id}/github-token?repo=sindre-ai%2Fmaskin`, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(401)
				const body = (await res.json()) as { error: { code: string } }
				expect(body.error.code).toBe('AUTH_REVOKED')
				fetchSpy.mockRestore()
			})

			it('short-circuits the write when a concurrent recovery already rotated the installation id', async () => {
				// Two parallel callers can both hit this route on the same
				// cached id. The second one's guarded re-read must observe the
				// already-rotated credentials row and skip both the UPDATE and
				// the audit event insert.
				const { encrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'

				const staleIntegration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const alreadyRotatedIntegration = {
					...staleIntegration,
					credentials: encrypt(JSON.stringify({ installation_id: '9999' })),
				}
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				// Route sees the stale row; the guarded re-read inside the txn sees
				// the row a concurrent caller has already rotated.
				mockResults.selectQueue = [[staleIntegration], [alreadyRotatedIntegration]]

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
					.mockResolvedValueOnce(new Response(JSON.stringify({ id: 9999 }), { status: 200 }))
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ token: 'ghs_recovered' }), { status: 200 }),
					)

				const res = await app.request(
					jsonGet(`/api/integrations/${staleIntegration.id}/github-token?repo=sindre-ai%2Fmaskin`, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				expect(await res.json()).toEqual({ token: 'ghs_recovered' })
				expect(calls.updates).toHaveLength(0)
				expect(calls.inserts).toHaveLength(0)
				fetchSpy.mockRestore()
			})

			it('still returns the fresh token when the audit event insert fails', async () => {
				// Credentials update commits first; a downstream audit failure
				// must not suppress the token response the caller is waiting on.
				const { encrypt } = await import('../../lib/crypto')
				process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED = 'true'

				const integration = buildIntegration({
					workspaceId: wsId,
					provider: 'github',
					status: 'active',
					credentials: encrypt(JSON.stringify({ installation_id: '42' })),
				})
				const { app, mockResults, calls } = createTestApp(integrationsRoutes, '/api/integrations')
				mockResults.selectQueue = [[integration], [integration]]
				mockResults.insertError = new Error('boom — events insert failed')

				const fetchSpy = vi
					.spyOn(globalThis, 'fetch')
					.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
					.mockResolvedValueOnce(new Response(JSON.stringify({ id: 9999 }), { status: 200 }))
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ token: 'ghs_recovered' }), { status: 200 }),
					)

				const res = await app.request(
					jsonGet(`/api/integrations/${integration.id}/github-token?repo=sindre-ai%2Fmaskin`, {
						'x-workspace-id': wsId,
					}),
				)

				expect(res.status).toBe(200)
				expect(await res.json()).toEqual({ token: 'ghs_recovered' })
				// Credentials rewrite still fired.
				expect(calls.updates).toHaveLength(1)
				fetchSpy.mockRestore()
			})
		})
	})

	describe('GET /api/integrations/:id/slack/conversations', () => {
		it('returns 200 with normalized list when integration is active Slack', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const { _resetSlackCaches } = await import('../../lib/integrations/providers/slack/client')
			_resetSlackCaches()

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'active',
				credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-test' })),
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[integration], [integration]] // route lookup, token lookup

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						channels: [
							{ id: 'C1', name: 'general', is_channel: true },
							{ id: 'G1', name: 'leadership', is_private: true },
						],
					}),
				),
			)

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/conversations`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			expect(body[0]).toMatchObject({ id: 'C1', name: 'general', is_channel: true })
			expect(body[1]).toMatchObject({ id: 'G1', name: 'leadership', is_private: true })
			fetchSpy.mockRestore()
		})

		it('returns 404 when integration is not Slack', async () => {
			const integration = buildIntegration({ workspaceId: wsId, provider: 'github' })
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [] // filter on provider='slack' returns nothing

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/conversations`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when types query param contains invalid value', async () => {
			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'active',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [integration]

			const res = await app.request(
				jsonGet(
					`/api/integrations/${integration.id}/slack/conversations?types=public_channel,nope`,
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/integrations/:id/slack/users', () => {
		it('returns 200 with filtered active users', async () => {
			const { encrypt } = await import('../../lib/crypto')
			const { _resetSlackCaches } = await import('../../lib/integrations/providers/slack/client')
			_resetSlackCaches()

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: 'slack',
				status: 'active',
				credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-test' })),
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.selectQueue = [[integration], [integration]]

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						members: [
							{ id: 'U1', name: 'alice', real_name: 'Alice', is_bot: false },
							{ id: 'U2', name: 'bob', deleted: true },
							{ id: 'U3', name: 'botty', real_name: 'Botty', is_bot: true },
						],
					}),
				),
			)

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/users`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2) // deleted user filtered out
			expect(body.map((u: { id: string }) => u.id)).toEqual(['U1', 'U3'])
			fetchSpy.mockRestore()
		})

		it('returns 404 when integration is for a different workspace', async () => {
			const integration = buildIntegration({
				workspaceId: 'other-workspace-id',
				provider: 'slack',
				status: 'active',
			})
			const { app, mockResults } = createTestApp(integrationsRoutes, '/api/integrations')
			mockResults.select = [] // workspaceId filter excludes it

			const res = await app.request(
				jsonGet(`/api/integrations/${integration.id}/slack/users`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})
})

describe('Webhook Routes', () => {
	describe('POST /api/webhooks/:provider', () => {
		it('returns 400 for unknown provider', async () => {
			const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')

			const res = await app.request(
				jsonRequest('POST', '/api/webhooks/nonexistent', { event: 'test' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Unknown provider')
		})

		// Guards DOD #1 of PR #492: when a provider opts into asyncProcessing, the
		// route must ack the webhook before the fan-out work finishes. If a regression
		// puts fan-out back on the hot path, the response would block on `fanOutGate`
		// and this test would time out.
		it('with asyncProcessing returns before webhookFanOut settles and acks { queued, workspaces }', async () => {
			const providerName = 'test-async-provider'
			const installationId = 'inst-async'

			let resolveFanOut!: () => void
			const fanOutGate = new Promise<void>((resolve) => {
				resolveFanOut = resolve
			})
			let fanOutStarted = false

			const normalizedEvent = {
				entityType: 'test.event',
				action: 'created' as const,
				installationId,
				data: { hello: 'world' },
			}

			const testProvider: ResolvedProvider = {
				config: {
					name: providerName,
					displayName: 'Test Async Provider',
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
					webhook: { type: 'custom' },
				},
				customWebhookVerifier: () => true,
				customNormalizer: () => normalizedEvent,
				asyncProcessing: true,
				webhookFanOut: async () => {
					fanOutStarted = true
					await fanOutGate
					return [normalizedEvent]
				},
			}

			vi.mocked(getProvider).mockReturnValueOnce(testProvider)

			const integration = buildIntegration({
				workspaceId: wsId,
				provider: providerName,
				status: 'active',
				externalId: installationId,
				config: { system_actor_id: 'system-actor-id' },
			})

			const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
			mockResults.select = [integration]

			const responsePromise = app.request(
				jsonRequest('POST', `/api/webhooks/${providerName}`, { hello: 'world' }),
			)

			const timeoutHandle = { id: undefined as ReturnType<typeof setTimeout> | undefined }
			const timeoutPromise = new Promise<'timeout'>((resolve) => {
				timeoutHandle.id = setTimeout(() => resolve('timeout'), 1000)
			})

			const winner = await Promise.race([
				responsePromise.then(() => 'response' as const),
				fanOutGate.then(() => 'fan-out-settled' as const),
				timeoutPromise,
			])
			if (timeoutHandle.id) clearTimeout(timeoutHandle.id)
			expect(winner).toBe('response')

			const res = await responsePromise
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual({ ok: true, queued: 1, workspaces: 1 })
			expect(fanOutStarted).toBe(true)

			// Let the queued background work complete so it doesn't bleed into other tests.
			resolveFanOut()
			await new Promise<void>((r) => setImmediate(r))
		})
	})
})
