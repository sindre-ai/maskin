import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { config } from '../../../../lib/integrations/providers/google-search-console/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Google Search Console provider config', () => {
	it('uses kebab-case provider name and human-readable display name', () => {
		expect(config.name).toBe('google-search-console')
		expect(config.displayName).toBe('Google Search Console')
	})

	it('uses standard oauth2 with PKCE and offline access', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://accounts.google.com/o/oauth2/v2/auth',
			)
			expect(config.auth.config.tokenUrl).toBe('https://oauth2.googleapis.com/token')
			expect(config.auth.config.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
			expect(config.auth.config.clientIdEnv).toBe('GOOGLE_SEARCH_CONSOLE_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.extraAuthParams).toMatchObject({
				access_type: 'offline',
				prompt: 'consent',
			})
		}
	})

	it('locks scopes to exactly webmasters.readonly (no scope creep)', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.scopes).toEqual([
				'https://www.googleapis.com/auth/webmasters.readonly',
			])
			// Guard against accidentally widening to the umbrella `webmasters`
			// scope (which grants write) or the URL Inspection scope — both
			// explicitly out of scope for task 1.
			expect(config.auth.config.scopes).not.toContain(
				'https://www.googleapis.com/auth/webmasters',
			)
			expect(config.auth.config.scopes).not.toContain(
				'https://www.googleapis.com/auth/webmasters.readonly.urlinspection',
			)
			// Identity/userinfo scopes are deferred to task 2 (sync needs a
			// per-property identity); task 1's bar is a single locked scope.
			expect(config.auth.config.scopes).not.toContain(
				'https://www.googleapis.com/auth/userinfo.email',
			)
			expect(config.auth.config.scopes).not.toContain('openid')
		}
	})

	it('emits the locked scope set on the generated authorization URL', async () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type !== 'oauth2') return

		const ORIGINAL_ID = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID
		process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = 'test-client-id'

		try {
			const { OAuth2Handler } = await import('../../../../lib/integrations/oauth/handler')
			const handler = new OAuth2Handler(config.auth.config)
			const url = new URL(
				handler.createAuthorizationUrl('state-token', 'https://maskin/cb', 'pkce-verifier'),
			)

			expect(url.searchParams.get('scope')).toBe(
				'https://www.googleapis.com/auth/webmasters.readonly',
			)
			expect(url.searchParams.get('access_type')).toBe('offline')
			expect(url.searchParams.get('prompt')).toBe('consent')
			expect(url.searchParams.get('code_challenge_method')).toBe('S256')
			expect(url.searchParams.get('client_id')).toBe('test-client-id')
		} finally {
			if (ORIGINAL_ID === undefined) {
				// biome-ignore lint/performance/noDelete: process.env assigns undefined as the string "undefined"; delete is required to truly unset the variable
				delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID
			} else {
				process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = ORIGINAL_ID
			}
		}
	})
})

describe('Google Search Console provider registration', () => {
	it('is registered under "google-search-console" and resolvable from the registry', () => {
		const resolved = getProvider('google-search-console')
		expect(resolved.config.name).toBe('google-search-console')
	})

	it('shows up in listProviders()', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('google-search-console')
	})

	it('wires preDisconnect so the disconnect endpoint revokes the Google grant', () => {
		const resolved = getProvider('google-search-console')
		expect(resolved.preDisconnect).toBeDefined()
	})

	it('does not wire resolveExternalId (deferred to task 2 with sync)', () => {
		const resolved = getProvider('google-search-console')
		expect(resolved.resolveExternalId).toBeUndefined()
	})
})

describe('revokeGoogleSearchConsoleGrant', () => {
	const ORIGINAL_CLIENT_ID = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID
	const ORIGINAL_CLIENT_SECRET = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET

	beforeAll(() => {
		process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = 'test-client-id'
		process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET = 'test-client-secret'
	})

	afterAll(() => {
		process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = ORIGINAL_CLIENT_ID
		process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET
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
		const { revokeGoogleSearchConsoleGrant } = await import(
			'../../../../lib/integrations/providers/google-search-console/disconnect'
		)

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: () => Promise.resolve(''),
		} as Response)

		await revokeGoogleSearchConsoleGrant(
			makeCtx({ accessToken: 'ya29.access', refreshToken: '1//refresh' }),
		)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://oauth2.googleapis.com/revoke')
		expect(init.method).toBe('POST')
		expect(String(init.body)).toBe('token=1%2F%2Frefresh')
	})

	it('falls back to the access token when no refresh token is stored', async () => {
		const { revokeGoogleSearchConsoleGrant } = await import(
			'../../../../lib/integrations/providers/google-search-console/disconnect'
		)

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: () => Promise.resolve(''),
		} as Response)

		await revokeGoogleSearchConsoleGrant(makeCtx({ accessToken: 'ya29.access' }))

		// biome-ignore lint/style/noNonNullAssertion: test asserts fetch was called above
		expect(String(fetchSpy.mock.calls[0]![1]?.body)).toBe('token=ya29.access')
	})

	it('swallows revoke errors so the disconnect flow always succeeds', async () => {
		const { revokeGoogleSearchConsoleGrant } = await import(
			'../../../../lib/integrations/providers/google-search-console/disconnect'
		)

		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: () => Promise.resolve('boom'),
		} as Response)

		await expect(
			revokeGoogleSearchConsoleGrant(makeCtx({ refreshToken: '1//refresh' })),
		).resolves.toBeUndefined()
	})

	it('is a no-op when credentials hold no usable token', async () => {
		const { revokeGoogleSearchConsoleGrant } = await import(
			'../../../../lib/integrations/providers/google-search-console/disconnect'
		)

		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		await revokeGoogleSearchConsoleGrant(makeCtx({}))

		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
