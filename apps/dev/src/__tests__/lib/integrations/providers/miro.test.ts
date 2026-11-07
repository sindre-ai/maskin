import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/miro/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Miro provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('miro')
		expect(config.displayName).toBe('Miro')
	})

	it('signs in at the MCP host with PKCE and asks for read and write up front', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.miro.com/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.miro.com/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(['boards:read', 'boards:write'])
			expect(config.auth.config.clientIdEnv).toBe('MIRO_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('MIRO_CLIENT_SECRET')
			// Miro's MCP host publishes no revocation endpoint.
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('MIRO_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.miro.com/',
			headers: { Authorization: 'Bearer ${MIRO_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('miro').config).toBe(config)
	})
})

describe('Miro through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('miro')).toBe(true)
	})

	it('treats a tool as a write unless Miro marks it read-only', () => {
		// No curated read list: a tool without a hint and without a read verb is a write.
		expect(classifyTool('miro', 'board_content_sync')).toBe('write')
		expect(classifyTool('miro', 'diagram_create', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('miro', 'context_get', { readOnlyHint: true })).toBe('read')
		// A destructive hint beats a read-only hint and a read-looking name.
		expect(classifyTool('miro', 'list_items', { readOnlyHint: true, destructiveHint: true })).toBe(
			'write',
		)
	})
})
