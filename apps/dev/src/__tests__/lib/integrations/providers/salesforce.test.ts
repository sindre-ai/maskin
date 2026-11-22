import { describe, expect, it } from 'vitest'
import { FLAGS } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/salesforce/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('Salesforce provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('salesforce')
		expect(config.displayName).toBe('Salesforce')
	})

	it('signs in with the code flow, PKCE and the two hosted MCP scopes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://login.salesforce.com/services/oauth2/authorize',
			)
			expect(config.auth.config.tokenUrl).toBe('https://login.salesforce.com/services/oauth2/token')
			expect(config.auth.config.scopes).toEqual(['mcp_api', 'refresh_token'])
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.tokenAuthMethod).toBe('client_secret_post')
		}
	})

	it('wants the customer own app, since Salesforce has no app Maskin can own', () => {
		expect(config.auth.type === 'oauth2' && config.auth.config.customerApp).toBe(true)
	})

	it('declares the hosted sobject-all server with a bearer token', () => {
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
			headers: { Authorization: 'Bearer ${SALESFORCE_TOKEN}' },
		})
		expect(config.mcp?.envKey).toBe('SALESFORCE_TOKEN')
	})

	it('is registered, gated by its flag, and counted by the gateway', () => {
		expect(getProvider('salesforce').config).toBe(config)
		expect(listProviders().map((p) => p.config.name)).toContain('salesforce')
		expect(GATEWAY_PROVIDERS.has('salesforce')).toBe(true)
		expect(FLAGS.SALESFORCE).toBe('salesforce')
	})

	it('is the only provider that asks for a customer app so far', () => {
		const asking = listProviders()
			.filter((p) => p.config.auth.type === 'oauth2' && p.config.auth.config.customerApp)
			.map((p) => p.config.name)
		expect(asking).toEqual(['salesforce'])
	})
})
