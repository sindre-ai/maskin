import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAuthRevokedError } from '../../../../lib/integrations/errors'
import { deepdotsAuth, signIn } from '../../../../lib/integrations/providers/deepdots/auth'
import { config } from '../../../../lib/integrations/providers/deepdots/config'
import type { CustomAuthContext, StoredCredentials } from '../../../../lib/integrations/types'

const originalFetch = globalThis.fetch

const PASSWORD = 'p4ssw0rd-do-not-log'

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response
}

function tokens(id: string, refresh: string) {
	return { idToken: id, refreshToken: refresh, expiresIn: 3600, tokenType: 'Bearer' }
}

/** A stored login whose hourly token is already due. */
function dueCredentials(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
	return {
		email: 'maskin@example.com',
		password: PASSWORD,
		accessToken: 'stale-id-token',
		refreshToken: 'stored-refresh',
		expiresAt: Date.now() - 1000,
		...overrides,
	}
}

describe('Deepdots provider config', () => {
	it('is a custom-auth provider shown by email', () => {
		expect(config.name).toBe('deepdots')
		expect(config.auth.type).toBe('oauth2_custom')
		expect(config.externalIdDisplay).toBe('email')
	})
})

describe('signIn', () => {
	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it('posts the email and password and returns the token with the login kept for renewal', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tokens('id-1', 'refresh-1')))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const creds = await signIn('maskin@example.com', PASSWORD)

		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.deepdots.com/auth/token')
		expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
			email: 'maskin@example.com',
			password: PASSWORD,
		})
		expect(creds.accessToken).toBe('id-1')
		expect(creds.refreshToken).toBe('refresh-1')
		expect(creds.email).toBe('maskin@example.com')
		expect(creds.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
	})

	it.each([401, 403])('says rejected on %i, and the error carries no password', async (status) => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ error: { message: 'Invalid email or password' } }, status),
			) as unknown as typeof fetch

		const err = await signIn('maskin@example.com', PASSWORD).catch((e) => e)

		expect(err.kind).toBe('rejected')
		expect(err.status).toBe(status)
		expect(JSON.stringify([err.message, err.stack])).not.toContain(PASSWORD)
	})

	it.each([429, 500, 502])('says transient on %i', async (status) => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({}, status)) as unknown as typeof fetch
		const err = await signIn('maskin@example.com', PASSWORD).catch((e) => e)
		expect(err.kind).toBe('transient')
	})

	it('says transient when Deepdots cannot be reached', async () => {
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch
		const err = await signIn('maskin@example.com', PASSWORD).catch((e) => e)
		expect(err.kind).toBe('transient')
	})
})

describe('deepdotsAuth.getAccessToken', () => {
	let persisted: StoredCredentials[]
	let stored: StoredCredentials
	let ctx: CustomAuthContext

	beforeEach(() => {
		persisted = []
		stored = dueCredentials()
		ctx = {
			integrationId: 'integration-1',
			persistCredentials: async (creds) => {
				persisted.push(creds)
				stored = creds
			},
			withRefreshLock: (fn) => fn(stored),
		}
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it('uses the stored token while it has more than 5 minutes left', async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const token = await deepdotsAuth.getAccessToken(
			dueCredentials({ accessToken: 'fresh', expiresAt: Date.now() + 30 * 60 * 1000 }),
			ctx,
		)

		expect(token).toBe('fresh')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('renews before the hour ends and saves the NEW refresh token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tokens('id-2', 'refresh-2')))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const token = await deepdotsAuth.getAccessToken(
			dueCredentials({ expiresAt: Date.now() + 60 * 1000 }),
			ctx,
		)

		expect(token).toBe('id-2')
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.deepdots.com/auth/token/refresh')
		expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
			refreshToken: 'stored-refresh',
		})
		expect(persisted).toHaveLength(1)
		expect(persisted[0]?.refreshToken).toBe('refresh-2')
		// The login survives, so a later refused refresh can still sign in again.
		expect(persisted[0]?.email).toBe('maskin@example.com')
		expect(persisted[0]?.password).toBe(PASSWORD)
	})

	it('does nothing when another server already renewed while it waited for the lock', async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		// The caller holds a stale copy; the lock hands over what is stored now.
		stored = dueCredentials({ accessToken: 'renewed-elsewhere', expiresAt: Date.now() + 3_600_000 })

		const token = await deepdotsAuth.getAccessToken(dueCredentials(), ctx)

		expect(token).toBe('renewed-elsewhere')
		expect(fetchMock).not.toHaveBeenCalled()
		expect(persisted).toHaveLength(0)
	})

	it('signs in again from the stored login when the refresh is refused', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({}, 401))
			.mockResolvedValueOnce(jsonResponse(tokens('id-3', 'refresh-3')))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const token = await deepdotsAuth.getAccessToken(dueCredentials(), ctx)

		expect(token).toBe('id-3')
		expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.deepdots.com/auth/token')
		expect(persisted[0]?.refreshToken).toBe('refresh-3')
	})

	it('signs in from the stored login when there is no refresh token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tokens('id-4', 'refresh-4')))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		stored = dueCredentials({ refreshToken: undefined })

		const token = await deepdotsAuth.getAccessToken(
			dueCredentials({ refreshToken: undefined }),
			ctx,
		)

		expect(token).toBe('id-4')
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.deepdots.com/auth/token')
	})

	it.each([401, 403])(
		'marks the connection as needing attention when sign-in is refused with %i',
		async (status) => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({}, 401)) // refresh refused
				.mockResolvedValueOnce(jsonResponse({}, status)) as unknown as typeof fetch

			const err = await deepdotsAuth.getAccessToken(dueCredentials(), ctx).catch((e) => e)

			expect(isAuthRevokedError(err)).toBe(true)
			expect(JSON.stringify([err.message, err.stack])).not.toContain(PASSWORD)
			expect(persisted).toHaveLength(0)
		},
	)

	it.each([429, 500, 503])(
		'does not mark the connection failed when the refresh answers %i',
		async (status) => {
			const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, status))
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const err = await deepdotsAuth.getAccessToken(dueCredentials(), ctx).catch((e) => e)

			expect(isAuthRevokedError(err)).toBe(false)
			// No second request that would fail the same way.
			expect(fetchMock).toHaveBeenCalledTimes(1)
		},
	)

	it('does not mark the connection failed when sign-in answers 429 or 5xx', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({}, 401))
			.mockResolvedValueOnce(jsonResponse({}, 503)) as unknown as typeof fetch

		const err = await deepdotsAuth.getAccessToken(dueCredentials(), ctx).catch((e) => e)

		expect(isAuthRevokedError(err)).toBe(false)
	})

	it('needs attention when there is no stored login to fall back on', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, 401)) as unknown as typeof fetch
		stored = dueCredentials({ email: undefined, password: undefined })

		const err = await deepdotsAuth.getAccessToken(stored, ctx).catch((e) => e)

		expect(isAuthRevokedError(err)).toBe(true)
	})
})
