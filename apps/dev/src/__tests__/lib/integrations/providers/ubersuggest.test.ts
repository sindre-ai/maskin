import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Identity state codec — the envelope stays readable JSON so these tests can
// assert on exactly what crosses the wire.
vi.mock('../../../../lib/integrations/oauth/state', () => ({
	decodeState: vi.fn((input: string) => JSON.parse(input)),
	encodeState: vi.fn((payload: unknown) => JSON.stringify(payload)),
}))

// deriveCodeVerifier is keyed by this; without it the handler refuses to run.
process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32)

import { isAuthRevokedError } from '../../../../lib/integrations/errors'
import { ubersuggestAuth } from '../../../../lib/integrations/providers/ubersuggest/auth'
import { config } from '../../../../lib/integrations/providers/ubersuggest/config'
import type { CustomAuthContext, StoredCredentials } from '../../../../lib/integrations/types'

const originalFetch = globalThis.fetch

/** Credentials whose access token expired an hour ago. */
function expiredCredentials(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
	return {
		accessToken: 'stale-access-token',
		refreshToken: 'stored-refresh-token',
		clientId: 'dyn-client-id',
		expiresAt: Date.now() - 60 * 60 * 1000,
		...overrides,
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response
}

describe('Ubersuggest provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('ubersuggest')
		expect(config.displayName).toBe('Ubersuggest')
	})

	it('uses custom OAuth2 — dynamic client registration is not the generic flow', () => {
		expect(config.auth.type).toBe('oauth2_custom')
	})

	it('declares the env key the frontend MCP preset interpolates', () => {
		// mcp-servers.tsx injects `Bearer ${UBERSUGGEST_TOKEN}`; session-manager
		// names the container env var from this envKey. A mismatch would leave the
		// header unsubstituted and surface as an opaque 401 from the MCP server.
		expect(config.mcp?.envKey).toBe('UBERSUGGEST_TOKEN')
	})

	it('does not auto-inject — Ubersuggest is opt-in per agent, not a workspace data pipe', () => {
		expect(config.mcp?.autoInject).toBeFalsy()
	})
})

describe('ubersuggestAuth.getAccessToken', () => {
	let persisted: StoredCredentials[]
	let ctx: CustomAuthContext

	beforeEach(() => {
		persisted = []
		ctx = {
			integrationId: 'integration-1',
			persistCredentials: async (creds) => {
				persisted.push(creds)
			},
		}
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it('returns the stored token without refreshing while it is still valid', async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const token = await ubersuggestAuth.getAccessToken(
			expiredCredentials({ accessToken: 'fresh', expiresAt: Date.now() + 60 * 60 * 1000 }),
			ctx,
		)

		expect(token).toBe('fresh')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('persists the rotated refresh token and the new expiry after a refresh', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({
				access_token: 'new-access-token',
				refresh_token: 'rotated-refresh-token',
				expires_in: 3600,
				token_type: 'Bearer',
			}),
		) as unknown as typeof fetch

		const token = await ubersuggestAuth.getAccessToken(expiredCredentials(), ctx)

		expect(token).toBe('new-access-token')
		expect(persisted).toHaveLength(1)
		expect(persisted[0]?.accessToken).toBe('new-access-token')
		// Dropping this would make the next refresh replay a consumed token.
		expect(persisted[0]?.refreshToken).toBe('rotated-refresh-token')
		expect(persisted[0]?.expiresAt).toBeGreaterThan(Date.now())
		// clientId must survive the merge — refresh is impossible without it.
		expect(persisted[0]?.clientId).toBe('dyn-client-id')
	})

	it('throws auth-revoked instead of returning the expired token when the grant is rejected', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ error: 'invalid_grant' }, 400),
		) as unknown as typeof fetch

		await expect(ubersuggestAuth.getAccessToken(expiredCredentials(), ctx)).rejects.toSatisfy(
			isAuthRevokedError,
		)
		expect(persisted).toHaveLength(0)
	})

	it('throws a non-revoked error on a transient provider failure', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ error: 'server_error' }, 503),
		) as unknown as typeof fetch

		const err = await ubersuggestAuth.getAccessToken(expiredCredentials(), ctx).catch((e) => e)

		expect(err).toBeInstanceOf(Error)
		// A 503 must not flip the integration to `revoked` — it is retryable.
		expect(isAuthRevokedError(err)).toBe(false)
	})

	it('throws when the token is expired and no refresh token is stored', async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch

		await expect(
			ubersuggestAuth.getAccessToken(expiredCredentials({ refreshToken: undefined }), ctx),
		).rejects.toSatisfy(isAuthRevokedError)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('throws when the refresh response omits access_token', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ token_type: 'Bearer' }),
		) as unknown as typeof fetch

		await expect(ubersuggestAuth.getAccessToken(expiredCredentials(), ctx)).rejects.toThrow(
			/omitted access_token/,
		)
		expect(persisted).toHaveLength(0)
	})
})

describe('ubersuggestAuth install/callback flow state', () => {
	const baseState = () =>
		JSON.stringify({ workspaceId: 'ws-1', actorId: 'actor-1', ts: Date.now(), nonce: 'nonce-1' })

	// What the connect route derives via resolvePublicOrigin and hands in.
	const REDIRECT_URI = 'https://app.example.test/api/integrations/ubersuggest/callback'

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it('forwards the state envelope unchanged — nothing extra rides to the provider', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ client_id: 'dyn-client-id' }),
		) as unknown as typeof fetch

		const register = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
		const state = baseState()
		const url = new URL(await ubersuggestAuth.getInstallUrl(state, REDIRECT_URI))

		// Ubersuggest's login parks this state in a cookie and embeds it three
		// times over; anything this handler adds is amplified ~4x and tips the
		// cookie past 4KB, at which point the provider answers
		// "`state` is missing or invalid". So it must go out byte-identical.
		expect(url.searchParams.get('state')).toBe(state)

		// The route-supplied redirect URI is what gets registered and what the
		// authorize step sends — the handler must not derive one of its own.
		expect(JSON.parse(register.mock.calls[0]?.[1]?.body as string).redirect_uris).toEqual([
			REDIRECT_URI,
		])
		expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		expect(url.searchParams.get('client_id')).toBe('dyn-client-id')
		expect(url.searchParams.get('code_challenge')).toEqual(expect.any(String))
	})

	it('completes the callback on a fresh module instance — no shared in-memory flow state', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ client_id: 'dyn-client-id' }),
		) as unknown as typeof fetch
		const state = baseState()
		const url = new URL(await ubersuggestAuth.getInstallUrl(state, REDIRECT_URI))
		const challenge = url.searchParams.get('code_challenge')

		// Re-import to simulate the callback being served by a different process
		// than the one that built the authorize URL (deploy, crash, second replica).
		vi.resetModules()
		const { ubersuggestAuth: freshAuth } = await import(
			'../../../../lib/integrations/providers/ubersuggest/auth'
		)
		const { createS256CodeChallenge } = await import('../../../../lib/integrations/oauth/pkce')

		const calls = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ client_id: 'dyn-client-id' }))
			.mockResolvedValueOnce(
				jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
			)
		globalThis.fetch = calls as unknown as typeof fetch

		const creds = await freshAuth.handleCallback({ code: 'auth-code', state }, REDIRECT_URI)

		expect(creds.accessToken).toBe('access-1')
		expect(creds.clientId).toBe('dyn-client-id')
		const body = new URLSearchParams(calls.mock.calls[1]?.[1]?.body as string)
		// The verifier is re-derived from the nonce in the state, never transmitted.
		expect(createS256CodeChallenge(body.get('code_verifier') as string)).toBe(challenge)
		expect(body.get('client_id')).toBe('dyn-client-id')
		// The route hands the same redirect URI to both legs of the flow.
		expect(body.get('redirect_uri')).toBe(REDIRECT_URI)
	})

	it('derives a distinct code verifier per flow nonce', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ client_id: 'dyn-client-id' }),
		) as unknown as typeof fetch

		const challengeFor = async (nonce: string) => {
			const state = JSON.stringify({ workspaceId: 'ws-1', actorId: 'a-1', ts: 1, nonce })
			const url = new URL(await ubersuggestAuth.getInstallUrl(state, REDIRECT_URI))
			return url.searchParams.get('code_challenge')
		}

		expect(await challengeFor('nonce-1')).not.toBe(await challengeFor('nonce-2'))
		// ...and is stable for the same nonce, which is what lets the callback
		// recover it without any stored per-flow state.
		expect(await challengeFor('nonce-1')).toBe(await challengeFor('nonce-1'))
	})

	it('rejects a state param with no nonce to derive from', async () => {
		const stateWithoutNonce = JSON.stringify({ workspaceId: 'ws-1', actorId: 'a-1', ts: 1 })
		await expect(
			ubersuggestAuth.handleCallback({ code: 'auth-code', state: stateWithoutNonce }, REDIRECT_URI),
		).rejects.toThrow(/missing its nonce/)
	})
})
