import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAuthRevokedError } from '../../../../../lib/integrations/errors'
import {
	DINERO_TOKEN_URL,
	dineroAuth,
	keysFrom,
	requestToken,
} from '../../../../../lib/integrations/providers/dinero/auth'
import { config } from '../../../../../lib/integrations/providers/dinero/config'
import type { CustomAuthContext, StoredCredentials } from '../../../../../lib/integrations/types'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const originalFetch = globalThis.fetch

const KEYS = { clientId: 'client-id-1', clientSecret: 'client-secret-1', apiKey: 'api-key-1' }

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response
}

const token = (value: string) => ({ access_token: value, token_type: 'Bearer', expires_in: 3600 })

/** Stored keys whose hourly token is already due. */
function due(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
	return {
		...KEYS,
		organizationId: 42,
		accessToken: 'stale',
		expiresAt: Date.now() - 1000,
		...overrides,
	}
}

function ctxFor(current: StoredCredentials) {
	const persistCredentials = vi.fn(async () => undefined)
	const ctx: CustomAuthContext = {
		integrationId: 'int-1',
		persistCredentials,
		withRefreshLock: async (fn) => fn(current),
	}
	return { ctx, persistCredentials }
}

afterEach(() => {
	globalThis.fetch = originalFetch
})

describe('Dinero provider config', () => {
	it('is a custom-auth provider whose MCP needs only the Maskin key', () => {
		expect(config.name).toBe('dinero')
		expect(config.auth.type).toBe('oauth2_custom')
		expect(config.mcp?.autoInject).toBe(false)
		expect(JSON.stringify(config.mcp?.server)).not.toContain('DINERO_TOKEN')
	})
})

describe('requestToken', () => {
	it('sends the password grant with the id and secret in a Basic header and the key as both username and password', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(token('t-1')))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const result = await requestToken(KEYS)

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(DINERO_TOKEN_URL)
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from('client-id-1:client-secret-1').toString('base64')}`,
		)
		const body = new URLSearchParams(String(init.body))
		expect(Object.fromEntries(body)).toEqual({
			grant_type: 'password',
			scope: 'read write',
			username: 'api-key-1',
			password: 'api-key-1',
		})
		expect(result.accessToken).toBe('t-1')
		expect(result.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
	})

	it.each([400, 401, 403])('says rejected on %i, and the error carries no key', async (status) => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({}, status)) as unknown as typeof fetch
		const err = await requestToken(KEYS).catch((e) => e)
		expect(err.kind).toBe('rejected')
		expect(JSON.stringify([err.message, err.stack])).not.toMatch(
			/client-id-1|client-secret-1|api-key-1/,
		)
	})

	it.each([429, 500, 503])('says transient on %i', async (status) => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({}, status)) as unknown as typeof fetch
		expect((await requestToken(KEYS).catch((e) => e)).kind).toBe('transient')
	})

	it('says transient when Dinero cannot be reached', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch
		expect((await requestToken(KEYS).catch((e) => e)).kind).toBe('transient')
	})

	it('treats an answer with no expiry as already due, not as non-expiring', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ access_token: 't-2' })) as unknown as typeof fetch
		const result = await requestToken(KEYS)
		expect(result.expiresAt).toBeLessThanOrEqual(Date.now())
	})
})

describe('dineroAuth.getAccessToken', () => {
	it('returns the stored token without calling Dinero while it has more than five minutes left', async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		const creds = due({ accessToken: 'fresh', expiresAt: Date.now() + 30 * 60 * 1000 })
		const { ctx, persistCredentials } = ctxFor(creds)

		expect(await dineroAuth.getAccessToken(creds, ctx)).toBe('fresh')
		expect(fetchMock).not.toHaveBeenCalled()
		expect(persistCredentials).not.toHaveBeenCalled()
	})

	it('asks again with the stored keys after the hour, with no person involved, and keeps the company', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(token('t-new')))
		globalThis.fetch = fetchMock as unknown as typeof fetch
		const creds = due()
		const { ctx, persistCredentials } = ctxFor(creds)

		expect(await dineroAuth.getAccessToken(creds, ctx)).toBe('t-new')
		expect(fetchMock).toHaveBeenCalledOnce()
		const saved = (persistCredentials.mock.calls[0] as unknown as [StoredCredentials])[0]
		expect(saved).toMatchObject({ ...KEYS, organizationId: 42, accessToken: 't-new' })
	})

	it('does not ask again when another server renewed while this one waited for the lock', async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		const renewed = due({ accessToken: 'by-other', expiresAt: Date.now() + 50 * 60 * 1000 })
		const { ctx } = ctxFor(renewed)

		expect(await dineroAuth.getAccessToken(due(), ctx)).toBe('by-other')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('marks the connection revoked when Dinero refuses the stored keys', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, 401)) as unknown as typeof fetch
		const creds = due()
		const { ctx } = ctxFor(creds)
		const err = await dineroAuth.getAccessToken(creds, ctx).catch((e) => e)
		expect(isAuthRevokedError(err)).toBe(true)
	})

	it('does not mark it revoked on a 5xx', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, 503)) as unknown as typeof fetch
		const creds = due()
		const { ctx } = ctxFor(creds)
		const err = await dineroAuth.getAccessToken(creds, ctx).catch((e) => e)
		expect(isAuthRevokedError(err)).toBe(false)
		expect(err.kind).toBe('transient')
	})

	it('asks for a reconnect when a stored key is missing', async () => {
		const creds = due({ apiKey: undefined })
		const { ctx } = ctxFor(creds)
		const err = await dineroAuth.getAccessToken(creds, ctx).catch((e) => e)
		expect(isAuthRevokedError(err)).toBe(true)
	})
})

describe('keysFrom', () => {
	it('needs all three values', () => {
		expect(keysFrom(due())).toEqual(KEYS)
		expect(keysFrom(due({ clientSecret: '' }))).toBeNull()
	})
})
