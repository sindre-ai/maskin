import { afterEach, describe, expect, it, vi } from 'vitest'
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

	it('does not declare an MCP server — tool wiring lands in T3', () => {
		expect(config.mcp).toBeUndefined()
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
			'Google Calendar userinfo response missing email',
		)
	})

	it('throws on HTTP error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: () => Promise.resolve('unauthorized'),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'expired' })).rejects.toThrow(
			'Failed to resolve Google Calendar email: HTTP 401',
		)
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
})
