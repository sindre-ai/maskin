import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { config } from '../../../../lib/integrations/providers/google-calendar/config'
import { resolveExternalId } from '../../../../lib/integrations/providers/google-calendar/resolve-id'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Google Calendar provider config', () => {
	it('uses kebab-case provider name and human-readable display name', () => {
		expect(config.name).toBe('google-calendar')
		expect(config.displayName).toBe('Google Calendar')
	})

	it('uses standard oauth2 with PKCE and offline access', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://accounts.google.com/o/oauth2/v2/auth',
			)
			expect(config.auth.config.tokenUrl).toBe('https://oauth2.googleapis.com/token')
			expect(config.auth.config.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
			expect(config.auth.config.clientIdEnv).toBe('GOOGLE_CALENDAR_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('GOOGLE_CALENDAR_CLIENT_SECRET')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.extraAuthParams).toMatchObject({
				access_type: 'offline',
				prompt: 'consent',
			})
		}
	})

	it('locks scopes to exactly calendar.readonly + calendar.events + userinfo.email + openid', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.scopes).toEqual([
				'https://www.googleapis.com/auth/calendar.readonly',
				'https://www.googleapis.com/auth/calendar.events',
				'https://www.googleapis.com/auth/userinfo.email',
				'openid',
			])
			// Guard against accidentally widening to the umbrella `calendar` scope
			// — write access must come through `calendar.events` only.
			expect(config.auth.config.scopes).not.toContain('https://www.googleapis.com/auth/calendar')
			expect(config.auth.config.scopes).not.toContain(
				'https://www.googleapis.com/auth/calendar.events.readonly',
			)
		}
	})

	it('emits the locked scope set on the generated authorization URL', async () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type !== 'oauth2') return

		const ORIGINAL_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID
		process.env.GOOGLE_CALENDAR_CLIENT_ID = 'test-client-id'

		try {
			const { OAuth2Handler } = await import('../../../../lib/integrations/oauth/handler')
			const handler = new OAuth2Handler(config.auth.config)
			const url = new URL(
				handler.createAuthorizationUrl('state-token', 'https://maskin/cb', 'pkce-verifier'),
			)

			expect(url.searchParams.get('scope')).toBe(
				[
					'https://www.googleapis.com/auth/calendar.readonly',
					'https://www.googleapis.com/auth/calendar.events',
					'https://www.googleapis.com/auth/userinfo.email',
					'openid',
				].join(' '),
			)
			expect(url.searchParams.get('access_type')).toBe('offline')
			expect(url.searchParams.get('prompt')).toBe('consent')
			expect(url.searchParams.get('code_challenge_method')).toBe('S256')
			expect(url.searchParams.get('client_id')).toBe('test-client-id')
		} finally {
			if (ORIGINAL_ID === undefined) {
				// biome-ignore lint/performance/noDelete: process.env assigns undefined as the string "undefined"; delete is required to truly unset the variable
				delete process.env.GOOGLE_CALENDAR_CLIENT_ID
			} else {
				process.env.GOOGLE_CALENDAR_CLIENT_ID = ORIGINAL_ID
			}
		}
	})

	it('wires Google Calendar to the hosted MCP endpoint via mcp-remote', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.args).toContain('https://calendarmcp.googleapis.com/mcp/v1')
		expect(config.mcp?.envKey).toBe('GOOGLE_CALENDAR_TOKEN')
	})
})

describe('Google Calendar resolveExternalId', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns the connected Google account email', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ email: 'magnus@example.com' }),
		} as Response)

		const id = await resolveExternalId({ accessToken: 'ya29.a0test' })

		expect(id).toBe('magnus@example.com')
		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://www.googleapis.com/oauth2/v2/userinfo',
			expect.objectContaining({
				headers: { Authorization: 'Bearer ya29.a0test' },
			}),
		)
	})

	it('throws when userinfo response is missing email', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'tok' })).rejects.toThrow(
			'Google userinfo response missing email field',
		)
	})

	it('throws on HTTP error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: () => Promise.resolve('unauthorized'),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'expired' })).rejects.toThrow(
			'Failed to resolve Google account email: HTTP 401',
		)
	})

	it('throws early without calling fetch when accessToken is absent', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		await expect(resolveExternalId({})).rejects.toThrow(
			'Cannot resolve Google account email: no access token in credentials',
		)
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})

describe('Google Calendar provider registration', () => {
	it('is registered under "google-calendar" and resolvable from the registry', () => {
		const resolved = getProvider('google-calendar')
		expect(resolved.config.name).toBe('google-calendar')
		expect(resolved.resolveExternalId).toBeDefined()
	})

	it('shows up in listProviders()', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('google-calendar')
	})

	it('wires preDisconnect so the disconnect endpoint revokes the Google grant', () => {
		const resolved = getProvider('google-calendar')
		expect(resolved.preDisconnect).toBeDefined()
	})
})

describe('revokeGoogleCalendarGrant', () => {
	const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID
	const ORIGINAL_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET

	beforeAll(() => {
		process.env.GOOGLE_CALENDAR_CLIENT_ID = 'test-client-id'
		process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'test-client-secret'
	})

	afterAll(() => {
		process.env.GOOGLE_CALENDAR_CLIENT_ID = ORIGINAL_CLIENT_ID
		process.env.GOOGLE_CALENDAR_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function makeCtx(credentials: Record<string, unknown>) {
		return {
			db: {} as unknown,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			credentials,
		}
	}

	it("POSTs the stored refresh token to Google's revoke endpoint", async () => {
		const { revokeGoogleCalendarGrant } = await import(
			'../../../../lib/integrations/providers/google-calendar/disconnect'
		)

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: () => Promise.resolve(''),
		} as Response)

		await revokeGoogleCalendarGrant(
			makeCtx({ accessToken: 'ya29.access', refreshToken: '1//refresh' }),
		)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://oauth2.googleapis.com/revoke')
		expect(init.method).toBe('POST')
		expect(String(init.body)).toBe('token=1%2F%2Frefresh')
	})

	it('falls back to the access token when no refresh token is stored', async () => {
		const { revokeGoogleCalendarGrant } = await import(
			'../../../../lib/integrations/providers/google-calendar/disconnect'
		)

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: () => Promise.resolve(''),
		} as Response)

		await revokeGoogleCalendarGrant(makeCtx({ accessToken: 'ya29.access' }))

		// biome-ignore lint/style/noNonNullAssertion: test asserts fetch was called above
		expect(String(fetchSpy.mock.calls[0]![1]?.body)).toBe('token=ya29.access')
	})

	it('swallows revoke errors so the disconnect flow always succeeds', async () => {
		const { revokeGoogleCalendarGrant } = await import(
			'../../../../lib/integrations/providers/google-calendar/disconnect'
		)

		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: () => Promise.resolve('boom'),
		} as Response)

		await expect(
			revokeGoogleCalendarGrant(makeCtx({ refreshToken: '1//refresh' })),
		).resolves.toBeUndefined()
	})

	it('is a no-op when credentials hold no usable token', async () => {
		const { revokeGoogleCalendarGrant } = await import(
			'../../../../lib/integrations/providers/google-calendar/disconnect'
		)

		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		await revokeGoogleCalendarGrant(makeCtx({}))

		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
