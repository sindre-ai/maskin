import { describe, expect, it } from 'vitest'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Google Calendar provider', () => {
	it('is registered and discoverable', () => {
		const provider = getProvider('google-calendar')
		expect(provider.config.name).toBe('google-calendar')
		expect(provider.config.displayName).toBe('Google Calendar')
		expect(provider.config.auth.type).toBe('oauth2')
	})

	it('has correct OAuth2 config', () => {
		const provider = getProvider('google-calendar')
		const auth = provider.config.auth
		if (auth.type !== 'oauth2') throw new Error('Expected oauth2')

		expect(auth.config.authorizationUrl).toContain('accounts.google.com')
		expect(auth.config.tokenUrl).toContain('googleapis.com/token')
		expect(auth.config.scopes).toContain('https://www.googleapis.com/auth/calendar.readonly')
		expect(auth.config.extraAuthParams?.access_type).toBe('offline')
		expect(auth.config.clientIdEnv).toBe('GOOGLE_CALENDAR_CLIENT_ID')
		expect(auth.config.clientSecretEnv).toBe('GOOGLE_CALENDAR_CLIENT_SECRET')
	})

	it('appears in listProviders', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('google-calendar')
	})
})
