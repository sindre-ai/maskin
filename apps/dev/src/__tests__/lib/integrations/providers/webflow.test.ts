import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/webflow/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Webflow provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('webflow')
		expect(config.displayName).toBe('Webflow')
	})

	it('signs in at the MCP host with PKCE and sends no scopes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.webflow.com/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.webflow.com/oauth/token')
			expect(config.auth.config.pkce).toBe(true)
			// Webflow's published details list no scopes, so none are sent.
			expect(config.auth.config.scopes).toEqual([])
			expect(config.auth.config.clientIdEnv).toBe('WEBFLOW_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('WEBFLOW_CLIENT_SECRET')
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('WEBFLOW_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.webflow.com/mcp',
			headers: { Authorization: 'Bearer ${WEBFLOW_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('webflow').config).toBe(config)
	})
})

describe('Webflow through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('webflow')).toBe(true)
	})

	it('treats a tool as a write unless Webflow marks it read-only', () => {
		expect(classifyTool('webflow', 'create_item')).toBe('write')
		expect(classifyTool('webflow', 'update_item', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('webflow', 'list_items', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('webflow', 'list_items', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
