import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/vercel/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Vercel provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('vercel')
		expect(config.displayName).toBe('Vercel')
	})

	it('signs in at vercel.com as a public client: PKCE, no secret, id from a metadata address', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://vercel.com/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://vercel.com/api/login/oauth/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(['openid', 'offline_access'])
			expect(config.auth.config.tokenAuthMethod).toBe('none')
			expect(config.auth.config.clientIdEnv).toBe('VERCEL_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBeUndefined()
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('VERCEL_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.vercel.com',
			headers: { Authorization: 'Bearer ${VERCEL_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('vercel').config).toBe(config)
	})
})

describe('Vercel through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('vercel')).toBe(true)
	})

	it('treats a tool as a write unless Vercel marks it read-only', () => {
		expect(classifyTool('vercel', 'deploy_to_vercel')).toBe('write')
		expect(classifyTool('vercel', 'web_fetch_vercel_url')).toBe('write')
		expect(classifyTool('vercel', 'list_deployments', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('vercel', 'list_deployments', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
