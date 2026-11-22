import { describe, expect, it } from 'vitest'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config } from '../../../../lib/integrations/providers/numina/config'
import { getProvider } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Numina provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('numina')
		expect(config.displayName).toBe('Numina')
	})

	it('signs in at the MCP host with PKCE and asks for read and draft scopes only', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://api.numina.app/oauth/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://api.numina.app/auth/oauth2/token')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(['read:ledger', 'write:draft', 'offline_access'])
			// Numina's MCP only saves drafts: no booking scope is ever requested.
			expect(config.auth.config.scopes?.some((s) => s.endsWith(':book'))).toBe(false)
			expect(config.auth.config.clientIdEnv).toBe('NUMINA_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('NUMINA_CLIENT_SECRET')
			expect(config.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('declares the hosted MCP server and its token variable', () => {
		expect(config.mcp?.envKey).toBe('NUMINA_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://api.numina.app/mcp',
			headers: { Authorization: 'Bearer ${NUMINA_TOKEN}' },
		})
	})

	it('is registered', () => {
		expect(getProvider('numina').config).toBe(config)
	})
})

describe('Numina through the gateway', () => {
	it('is served by the gateway, so a read-only agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has('numina')).toBe(true)
	})

	it('treats a tool as a write unless Numina marks it read-only', () => {
		expect(classifyTool('numina', 'create_draft')).toBe('write')
		expect(classifyTool('numina', 'propose_booked_change', { readOnlyHint: false })).toBe('write')
		expect(classifyTool('numina', 'get_trial_balance', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool('numina', 'list_invoices', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})
