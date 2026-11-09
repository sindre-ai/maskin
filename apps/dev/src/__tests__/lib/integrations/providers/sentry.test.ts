import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/sentry/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Sentry provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('sentry')
		expect(config.displayName).toBe('Sentry')
	})

	it('signs in at the MCP host with PKCE and asks for its read and write scopes up front', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.sentry.dev/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.sentry.dev/oauth/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual([
				'org:read',
				'project:write',
				'team:write',
				'event:write',
				'alerts:write',
			])
			expect(config.auth.config.clientIdEnv).toBe('SENTRY_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('SENTRY_CLIENT_SECRET')
			// Sentry's revocation endpoint is its token URL, which the revoke call does not fit.
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('SENTRY_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.sentry.dev/mcp',
			headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('sentry').config).toBe(config)
	})
})

describe('Sentry through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('sentry')).toBe(true)
	})

	it('treats a tool as a write unless Sentry marks it read-only', () => {
		// No curated read list: a tool without a hint and without a read verb is a write.
		expect(classifyTool('sentry', 'update_issue')).toBe('write')
		expect(classifyTool('sentry', 'update_project', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('sentry', 'get_issue_details', { readOnlyHint: true })).toBe('read')
		// A destructive hint beats a read-only hint and a read-looking name.
		expect(
			classifyTool('sentry', 'list_issues', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
