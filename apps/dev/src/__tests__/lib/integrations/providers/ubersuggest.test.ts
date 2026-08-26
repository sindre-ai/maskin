import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Identity crypto — the state envelope stays readable JSON so these tests can
// assert on what actually crosses the wire.
vi.mock('../../../../lib/crypto', () => ({
	decrypt: vi.fn((input: string) => input),
	encrypt: vi.fn((input: string) => input),
}))

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

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it('carries the PKCE material in the state param, not in process memory', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ client_id: 'dyn-client-id' }),
		) as unknown as typeof fetch

		const url = new URL(await ubersuggestAuth.getInstallUrl(baseState()))
		const returnedState = url.searchParams.get('state')

		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		expect(url.searchParams.get('client_id')).toBe('dyn-client-id')

		const payload = JSON.parse(returnedState as string)
		// The framework's own fields must survive untouched — the callback route
		// validates nonce/workspaceId/actorId/ts off this same envelope.
		expect(payload.nonce).toBe('nonce-1')
		expect(payload.workspaceId).toBe('ws-1')
		expect(payload.actorId).toBe('actor-1')
		expect(payload.ubersuggest.clientId).toBe('dyn-client-id')
		expect(payload.ubersuggest.codeVerifier).toEqual(expect.any(String))
		expect(payload.ubersuggest.redirectUri).toContain('/api/integrations/ubersuggest/callback')
	})

	it('completes the callback on a fresh module instance — no shared in-memory flow state', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonResponse({ client_id: 'dyn-client-id' }),
		) as unknown as typeof fetch
		const url = new URL(await ubersuggestAuth.getInstallUrl(baseState()))
		const state = url.searchParams.get('state') as string

		// Re-import to simulate the callback being served by a different process
		// than the one that built the authorize URL (deploy, crash, second replica).
		vi.resetModules()
		const { ubersuggestAuth: freshAuth } = await import(
			'../../../../lib/integrations/providers/ubersuggest/auth'
		)

		const exchange = vi.fn(async () =>
			jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
		)
		globalThis.fetch = exchange as unknown as typeof fetch

		const creds = await freshAuth.handleCallback({ code: 'auth-code', state })

		expect(creds.accessToken).toBe('access-1')
		expect(creds.clientId).toBe('dyn-client-id')
		const body = new URLSearchParams(exchange.mock.calls[0]?.[1]?.body as string)
		expect(body.get('code_verifier')).toBe(JSON.parse(state).ubersuggest.codeVerifier)
		expect(body.get('client_id')).toBe('dyn-client-id')
	})

	it('rejects a state param with no embedded PKCE material', async () => {
		await expect(
			ubersuggestAuth.handleCallback({ code: 'auth-code', state: baseState() }),
		).rejects.toThrow(/missing PKCE material/)
	})
})
