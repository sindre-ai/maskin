import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/amplitude/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Amplitude provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('amplitude')
		expect(config.displayName).toBe('Amplitude')
	})

	it('signs in at the MCP host with PKCE and asks for read and write scopes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.amplitude.com/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.amplitude.com/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(expect.arrayContaining(['all:read', 'all:write']))
			expect(config.auth.config.clientIdEnv).toBe('AMPLITUDE_CLIENT_ID')
			expect(config.auth.config.tokenAuthMethod).toBe('none')
			expect(config.auth.config.clientSecretEnv).toBeUndefined()
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('AMPLITUDE_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.amplitude.com/mcp',
			headers: { Authorization: 'Bearer ${AMPLITUDE_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('amplitude').config).toBe(config)
	})
})

describe('Amplitude through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('amplitude')).toBe(true)
	})

	it('treats a tool as a write unless Amplitude marks it read-only', () => {
		expect(classifyTool('amplitude', 'create_item')).toBe('write')
		expect(classifyTool('amplitude', 'update_item', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('amplitude', 'list_items', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('amplitude', 'list_items', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
