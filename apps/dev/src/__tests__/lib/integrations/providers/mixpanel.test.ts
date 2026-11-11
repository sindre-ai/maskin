import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/mixpanel/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Mixpanel provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('mixpanel')
		expect(config.displayName).toBe('Mixpanel')
	})

	it('signs in at Mixpanel with PKCE and the scopes Mixpanel publishes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mixpanel.com/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mixpanel.com/oauth/token/')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(expect.arrayContaining(['data:read', 'projects']))
			expect(config.auth.config.clientIdEnv).toBe('MIXPANEL_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('MIXPANEL_CLIENT_SECRET')
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('MIXPANEL_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.mixpanel.com/mcp',
			headers: { Authorization: 'Bearer ${MIXPANEL_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('mixpanel').config).toBe(config)
	})
})

describe('Mixpanel through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('mixpanel')).toBe(true)
	})

	it('treats a tool as a write unless Mixpanel marks it read-only', () => {
		expect(classifyTool('mixpanel', 'create_item')).toBe('write')
		expect(classifyTool('mixpanel', 'update_item', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('mixpanel', 'list_items', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('mixpanel', 'list_items', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
