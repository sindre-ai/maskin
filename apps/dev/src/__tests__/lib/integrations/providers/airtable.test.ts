import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/airtable/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Airtable provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('airtable')
		expect(config.displayName).toBe('Airtable')
	})

	it("signs in at Airtable's server with PKCE, the secret in the header, and read and write scopes", () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://airtable.com/oauth2/v1/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://airtable.com/oauth2/v1/token')
			expect(config.auth.config.pkce).toBe(true)
			// Airtable's token endpoint offers client_secret_basic or none, not client_secret_post.
			expect(config.auth.config.tokenAuthMethod).toBe('client_secret_basic')
			expect(config.auth.config.scopes).toEqual(
				expect.arrayContaining(['data.records:read', 'data.records:write']),
			)
			expect(config.auth.config.clientIdEnv).toBe('AIRTABLE_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('AIRTABLE_CLIENT_SECRET')
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('AIRTABLE_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.airtable.com/mcp',
			headers: { Authorization: 'Bearer ${AIRTABLE_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('airtable').config).toBe(config)
	})
})

describe('Airtable through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('airtable')).toBe(true)
	})

	it('treats a tool as a write unless Airtable marks it read-only', () => {
		expect(classifyTool('airtable', 'create_table')).toBe('write')
		expect(classifyTool('airtable', 'update_records', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('airtable', 'list_records', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('airtable', 'list_records', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
