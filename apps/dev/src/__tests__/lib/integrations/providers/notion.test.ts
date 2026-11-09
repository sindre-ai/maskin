import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/notion/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Notion provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('notion')
		expect(config.displayName).toBe('Notion')
	})

	it('signs in at the MCP host with PKCE and asks for its one scope', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.notion.com/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.notion.com/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(['default'])
			expect(config.auth.config.clientIdEnv).toBe('NOTION_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('NOTION_CLIENT_SECRET')
			// Notion's revocation endpoint is its token URL, which the revoke call does not fit.
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('NOTION_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.notion.com/mcp',
			headers: { Authorization: 'Bearer ${NOTION_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('notion').config).toBe(config)
	})
})

describe('Notion through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('notion')).toBe(true)
	})

	it('treats a tool as a write unless Notion marks it read-only', () => {
		// No curated read list: a tool without a hint and without a read verb is a write.
		expect(classifyTool('notion', 'page_move_batch')).toBe('write')
		expect(classifyTool('notion', 'page_create', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('notion', 'page_fetch', { readOnlyHint: true })).toBe('read')
		// A destructive hint beats a read-only hint and a read-looking name.
		expect(
			classifyTool('notion', 'list_pages', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
