import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/clickup/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('ClickUp provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('clickup')
		expect(config.displayName).toBe('ClickUp')
	})

	it('signs in at the MCP host as a public client: PKCE, read and write scopes, no secret', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.clickup.com/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.clickup.com/oauth/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.tokenAuthMethod).toBe('none')
			expect(config.auth.config.scopes).toEqual(expect.arrayContaining(['read', 'write']))
			expect(config.auth.config.clientIdEnv).toBe('CLICKUP_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBeUndefined()
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('CLICKUP_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.clickup.com/mcp',
			headers: { Authorization: 'Bearer ${CLICKUP_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('clickup').config).toBe(config)
	})
})

describe('ClickUp through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('clickup')).toBe(true)
	})

	it('treats a tool as a write unless ClickUp marks it read-only', () => {
		expect(classifyTool('clickup', 'create_item')).toBe('write')
		expect(classifyTool('clickup', 'update_item', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('clickup', 'list_items', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('clickup', 'list_items', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
