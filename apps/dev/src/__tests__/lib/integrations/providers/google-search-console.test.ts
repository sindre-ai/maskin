import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { config } from '../../../../lib/integrations/providers/google-search-console/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { integrationScopeGaps } from '../../../../lib/integrations/scope-drift'

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

	it('locks scopes to exactly webmasters (no scope creep)', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			// The full scope, not webmasters.readonly: Google only accepts sitemap
			// submit and delete under it. Listing sites, search analytics and URL
			// Inspection accept either, so the daily sync is unchanged.
			expect(config.auth.config.scopes).toEqual(['https://www.googleapis.com/auth/webmasters'])
			expect(config.auth.config.scopes).not.toContain(
				'https://www.googleapis.com/auth/webmasters.readonly',
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

	it('flags a connection made under the read-only scope as needing a reconnect', () => {
		expect(
			integrationScopeGaps(config, {
				scope: 'https://www.googleapis.com/auth/webmasters.readonly',
			}),
		).toEqual({
			missing: ['https://www.googleapis.com/auth/webmasters'],
			needsReconnect: true,
		})
		expect(
			integrationScopeGaps(config, { scope: 'https://www.googleapis.com/auth/webmasters' }),
		).toEqual({ missing: [], needsReconnect: false })
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

			expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/webmasters')
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

	// Revoking at Google kills the grant for every workspace sharing this OAuth client and
	// Google account, so disconnecting here must only flip the Maskin row.
	it('does not revoke the Google grant on disconnect', () => {
		const resolved = getProvider('google-search-console')
		expect(resolved.preDisconnect).toBeUndefined()
	})

	it('does not wire resolveExternalId (deferred to task 2 with sync)', () => {
		const resolved = getProvider('google-search-console')
		expect(resolved.resolveExternalId).toBeUndefined()
	})
})
