import { describe, expect, it } from 'vitest'
import { linkedinAuth } from '../../../../lib/integrations/providers/linkedin/auth'
import { config } from '../../../../lib/integrations/providers/linkedin/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('LinkedIn provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('linkedin')
		expect(config.displayName).toBe('LinkedIn')
	})

	it('uses oauth2_custom auth type', () => {
		expect(config.auth.type).toBe('oauth2_custom')
	})

	it('has no webhook config', () => {
		expect(config.webhook).toBeUndefined()
	})

	it('has MCP config with LINKEDIN_TOKEN envKey', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.envKey).toBe('LINKEDIN_TOKEN')
	})
})

describe('linkedinAuth', () => {
	describe('getInstallUrl', () => {
		it('throws — LinkedIn does not use the install-URL flow', () => {
			expect(() => linkedinAuth.getInstallUrl('some-state')).toThrow(/auth-browser\/start/)
		})
	})

	describe('handleCallback', () => {
		it('stores li_at, jsessionid, and profile_url', async () => {
			const result = await linkedinAuth.handleCallback({
				li_at: 'AQEDAT...',
				jsessionid: 'ajax:1234567890',
				profile_url: 'https://www.linkedin.com/in/some-user/',
			})
			expect(result).toEqual({
				li_at: 'AQEDAT...',
				jsessionid: 'ajax:1234567890',
				profile_url: 'https://www.linkedin.com/in/some-user/',
			})
		})

		it('accepts li_at alone (optional fields omitted)', async () => {
			const result = await linkedinAuth.handleCallback({ li_at: 'AQEDAT...' })
			expect(result).toEqual({ li_at: 'AQEDAT...' })
		})

		it('throws when li_at is missing', async () => {
			await expect(linkedinAuth.handleCallback({})).rejects.toThrow(
				'Missing li_at cookie in callback',
			)
		})
	})

	describe('getAccessToken', () => {
		it('returns a Cookie-header string with li_at and JSESSIONID', async () => {
			const token = await linkedinAuth.getAccessToken({
				li_at: 'AQEDAT-abc',
				jsessionid: 'ajax:9999',
			})
			expect(token).toBe('li_at=AQEDAT-abc; JSESSIONID="ajax:9999"')
		})

		it('omits JSESSIONID when not present', async () => {
			const token = await linkedinAuth.getAccessToken({ li_at: 'AQEDAT-abc' })
			expect(token).toBe('li_at=AQEDAT-abc')
		})

		it('throws when li_at is missing', async () => {
			await expect(linkedinAuth.getAccessToken({})).rejects.toThrow(
				'LinkedIn credentials missing li_at',
			)
		})
	})
})

describe('registry registration', () => {
	it('exposes linkedin via getProvider', () => {
		const provider = getProvider('linkedin')
		expect(provider.config.name).toBe('linkedin')
		expect(provider.customAuth).toBeDefined()
		expect(provider.customAuth).toBe(linkedinAuth)
	})

	it('includes linkedin in listProviders', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('linkedin')
	})
})
