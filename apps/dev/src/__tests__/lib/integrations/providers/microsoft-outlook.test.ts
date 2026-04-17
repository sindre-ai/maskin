import { describe, expect, it } from 'vitest'
import { config } from '../../../../lib/integrations/providers/microsoft-outlook/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Microsoft Outlook provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('microsoft-outlook')
		expect(config.displayName).toBe('Microsoft Outlook')
	})

	it('uses standard oauth2 auth type against the Microsoft Identity "common" endpoint', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
			)
			expect(config.auth.config.tokenUrl).toBe(
				'https://login.microsoftonline.com/common/oauth2/v2.0/token',
			)
			expect(config.auth.config.clientIdEnv).toBe('MICROSOFT_OUTLOOK_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('MICROSOFT_OUTLOOK_CLIENT_SECRET')
		}
	})

	it('requests Calendars.Read and offline_access scopes', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		expect(config.auth.config.scopes).toContain('Calendars.Read')
		expect(config.auth.config.scopes).toContain('offline_access')
	})

	it('does not declare a webhook config (Graph subscriptions are set up separately)', () => {
		expect(config.webhook).toBeUndefined()
	})
})

describe('registry: microsoft-outlook', () => {
	it('resolves the microsoft-outlook provider', () => {
		const provider = getProvider('microsoft-outlook')
		expect(provider.config.name).toBe('microsoft-outlook')
	})

	it('appears in listProviders()', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('microsoft-outlook')
	})
})
