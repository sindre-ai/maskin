import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { UNICONTA_PROVIDER, config } from '../../../../lib/integrations/providers/uniconta/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Uniconta provider config', () => {
	it('signs in at Uniconta as a public client with PKCE and no scopes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe('https://mcp.uniconta.com/authorize')
			expect(config.auth.config.tokenUrl).toBe('https://mcp.uniconta.com/token')
			expect(config.auth.config.revokeUrl).toBe('https://mcp.uniconta.com/revoke')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.tokenAuthMethod).toBe('none')
			expect(config.auth.config.clientIdEnv).toBe('UNICONTA_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBeUndefined()
			expect(config.auth.config.scopes).toEqual([])
		}
	})

	it('declares the hosted MCP server with a bearer token', () => {
		expect(config.mcp?.envKey).toBe('UNICONTA_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.uniconta.com/mcp',
			headers: { Authorization: 'Bearer ${UNICONTA_TOKEN}' },
		})
	})

	it('is registered and served by the gateway', () => {
		expect(getProvider(UNICONTA_PROVIDER).config).toBe(config)
		expect(listProviders().map((p) => p.config.name)).toContain(UNICONTA_PROVIDER)
		expect(GATEWAY_PROVIDERS.has(UNICONTA_PROVIDER)).toBe(true)
	})

	it('treats a tool as a write unless the server marks it read-only', () => {
		expect(classifyTool(UNICONTA_PROVIDER, 'create_quick_invoice')).toBe('write')
		expect(classifyTool(UNICONTA_PROVIDER, 'invoice_order')).toBe('write')
		expect(classifyTool(UNICONTA_PROVIDER, 'a_tool_added_later')).toBe('write')
		expect(classifyTool(UNICONTA_PROVIDER, 'query_entity', { readOnlyHint: true })).toBe('read')
	})
})

describe('uniconta-connect flag', () => {
	it('is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.UNICONTA_CONNECT,
		})
		expect(isFlagEnabled(actor, FLAGS.UNICONTA_CONNECT, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.UNICONTA_CONNECT, on)).toBe(true)
	})
})
