import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/atlassian/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Atlassian provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('atlassian')
		expect(config.displayName).toBe('Atlassian')
	})

	it('signs in at auth.atlassian.com with PKCE and asks for read, write and search up front', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://auth.atlassian.com/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://auth.atlassian.com/oauth/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual([
				'offline_access',
				'read:me',
				'read:jira:agent-interface',
				'write:jira:agent-interface',
				'search:jira:agent-interface',
				'read:confluence:agent-interface',
				'write:confluence:agent-interface',
				'search:confluence:agent-interface',
			])
			expect(config.auth.config.clientIdEnv).toBe('ATLASSIAN_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('ATLASSIAN_CLIENT_SECRET')
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the v2 hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('ATLASSIAN_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.atlassian.com/v2/mcp',
			headers: { Authorization: 'Bearer ${ATLASSIAN_TOKEN}' },
		})
		// v1 is retired on 1 Mar 2027.
		expect(JSON.stringify(config.mcp)).not.toContain('/v1/')
	})

	it('is registered', () => {
		expect(getProvider('atlassian').config).toBe(config)
	})
})

describe('Atlassian through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('atlassian')).toBe(true)
	})

	it('treats a tool as a write unless Atlassian marks it read-only', () => {
		// No curated read list: a tool without a hint and without a read verb is a write.
		expect(classifyTool('atlassian', 'transitionJiraIssue')).toBe('write')
		expect(classifyTool('atlassian', 'createJiraIssue', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('atlassian', 'getJiraIssue', { readOnlyHint: true })).toBe('read')
		// A destructive hint beats a read-only hint and a read-looking name.
		expect(
			classifyTool('atlassian', 'searchJiraIssues', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
