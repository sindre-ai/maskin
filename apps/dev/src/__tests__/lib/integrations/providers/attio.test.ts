import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/attio/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Attio provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('attio')
		expect(config.displayName).toBe('Attio')
	})

	it('signs in at app.attio.com with PKCE and asks for the MCP scope plus a refresh token', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://app.attio.com/oidc/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://app.attio.com/oidc/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(['openid', 'offline_access', 'mcp'])
			expect(config.auth.config.clientIdEnv).toBe('ATTIO_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('ATTIO_CLIENT_SECRET')
			// Attio's revoke endpoint has not been tried against the handler's revoke call, so none is set.
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('ATTIO_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.attio.com/mcp',
			headers: { Authorization: 'Bearer ${ATTIO_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('attio').config).toBe(config)
	})
})

describe('Attio through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('attio')).toBe(true)
	})

	it('treats a tool as a write unless Attio marks it read-only', () => {
		// No curated read list: a tool without a hint and without a read verb is a write.
		expect(classifyTool('attio', 'update-record')).toBe('write')
		expect(classifyTool('attio', 'create-record', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('attio', 'get-record', { readOnlyHint: true })).toBe('read')
		// A destructive hint beats a read-only hint and a read-looking name.
		expect(
			classifyTool('attio', 'list-records', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
