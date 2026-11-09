import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/intercom/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Intercom provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('intercom')
		expect(config.displayName).toBe('Intercom')
	})

	it('signs in at the MCP host with PKCE and asks for its tool scope', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.intercom.com/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.intercom.com/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(['mcp'])
			expect(config.auth.config.clientIdEnv).toBe('INTERCOM_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('INTERCOM_CLIENT_SECRET')
			// Intercom's revocation endpoint is its token URL, which the revoke call does not fit.
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted US MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('INTERCOM_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.intercom.com/mcp',
			headers: { Authorization: 'Bearer ${INTERCOM_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('intercom').config).toBe(config)
	})
})

describe('Intercom through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('intercom')).toBe(true)
	})

	it('treats a tool as a write unless Intercom marks it read-only', () => {
		expect(classifyTool('intercom', 'update_conversation')).toBe('write')
		expect(classifyTool('intercom', 'reply_conversation', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('intercom', 'get_conversation', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('intercom', 'list_contacts', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
