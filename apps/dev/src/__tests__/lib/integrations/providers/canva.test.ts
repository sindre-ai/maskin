import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/canva/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Canva provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('canva')
		expect(config.displayName).toBe('Canva')
	})

	it('signs in at the MCP host with PKCE and asks for read and write scopes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.canva.com/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.canva.com/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toContain('design:content:read')
			expect(config.auth.config.scopes).toContain('design:content:write')
			expect(config.auth.config.scopes).not.toContain('help:answers:write')
			expect(config.auth.config.clientIdEnv).toBe('CANVA_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('CANVA_CLIENT_SECRET')
			// Canva's revocation endpoint is its token URL, which the revoke call does not fit.
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('CANVA_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.canva.com/mcp',
			headers: { Authorization: 'Bearer ${CANVA_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('canva').config).toBe(config)
	})
})

describe('Canva through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('canva')).toBe(true)
	})

	it('treats a tool as a write unless Canva marks it read-only', () => {
		// No curated read list: a tool without a hint and without a read verb is a write.
		expect(classifyTool('canva', 'move_batch')).toBe('write')
		expect(classifyTool('canva', 'create_design', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('canva', 'get_design', { readOnlyHint: true })).toBe('read')
		// A destructive hint beats a read-only hint and a read-looking name.
		expect(
			classifyTool('canva', 'list_designs', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
