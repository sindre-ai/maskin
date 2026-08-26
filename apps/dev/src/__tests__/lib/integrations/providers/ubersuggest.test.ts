import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
