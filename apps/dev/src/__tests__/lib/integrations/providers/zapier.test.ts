import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/zapier/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Zapier provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('zapier')
		expect(config.displayName).toBe('Zapier')
	})

	it('signs in at Zapier with PKCE and the three scopes Zapier publishes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.zapier.com/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.zapier.com/api/v1/oauth/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(
				expect.arrayContaining(['openid', 'profile', 'email']),
			)
			expect(config.auth.config.clientIdEnv).toBe('ZAPIER_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('ZAPIER_CLIENT_SECRET')
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('ZAPIER_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.zapier.com/api/mcp/mcp',
			headers: { Authorization: 'Bearer ${ZAPIER_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('zapier').config).toBe(config)
	})
})

describe('Zapier through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('zapier')).toBe(true)
	})

	it('treats a tool as a write unless Zapier marks it read-only', () => {
		expect(classifyTool('zapier', 'create_item')).toBe('write')
		expect(classifyTool('zapier', 'update_item', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('zapier', 'list_items', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('zapier', 'list_items', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
