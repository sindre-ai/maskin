import { describe, expect, it } from 'vitest'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Outlook Calendar provider', () => {
	it('is registered and discoverable', () => {
		const provider = getProvider('outlook-calendar')
		expect(provider.config.name).toBe('outlook-calendar')
		expect(provider.config.displayName).toBe('Outlook Calendar')
		expect(provider.config.auth.type).toBe('oauth2')
	})

	it('has correct OAuth2 config', () => {
		const provider = getProvider('outlook-calendar')
		const auth = provider.config.auth
		if (auth.type !== 'oauth2') throw new Error('Expected oauth2')

		expect(auth.config.authorizationUrl).toContain('login.microsoftonline.com')
		expect(auth.config.tokenUrl).toContain('login.microsoftonline.com')
		expect(auth.config.scopes).toContain('Calendars.Read')
		expect(auth.config.scopes).toContain('offline_access')
		expect(auth.config.clientIdEnv).toBe('OUTLOOK_CLIENT_ID')
		expect(auth.config.clientSecretEnv).toBe('OUTLOOK_CLIENT_SECRET')
	})

	it('appears in listProviders', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('outlook-calendar')
	})
})
