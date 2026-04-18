import { describe, expect, it } from 'vitest'
import { config } from '../../../../lib/integrations/providers/google-calendar/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Google Calendar provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('google-calendar')
		expect(config.displayName).toBe('Google Calendar')
	})

	it('uses standard oauth2 auth type', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://accounts.google.com/o/oauth2/v2/auth',
			)
			expect(config.auth.config.tokenUrl).toBe('https://oauth2.googleapis.com/token')
			expect(config.auth.config.clientIdEnv).toBe('GOOGLE_CALENDAR_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('GOOGLE_CALENDAR_CLIENT_SECRET')
		}
	})

	it('requests calendar.readonly and calendar.events.readonly scopes', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		expect(config.auth.config.scopes).toContain('https://www.googleapis.com/auth/calendar.readonly')
		expect(config.auth.config.scopes).toContain(
			'https://www.googleapis.com/auth/calendar.events.readonly',
		)
	})

	it('requests offline access + consent prompt to get refresh tokens', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		expect(config.auth.config.extraAuthParams).toEqual({
			access_type: 'offline',
			prompt: 'consent',
		})
	})

	it('does not declare a webhook config (Google Calendar uses push notifications separately)', () => {
		expect(config.webhook).toBeUndefined()
	})
})

describe('registry: google-calendar', () => {
	it('resolves the google-calendar provider', () => {
		const provider = getProvider('google-calendar')
		expect(provider.config.name).toBe('google-calendar')
	})

	it('appears in listProviders()', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('google-calendar')
	})
})
