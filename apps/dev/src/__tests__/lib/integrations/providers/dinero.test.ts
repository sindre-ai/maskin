import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import {
	GATEWAY_PROVIDERS,
	buildUpstreamHeaders,
	gatewayServerSpec,
	rewriteMcpServersForGateway,
} from '../../../../lib/integrations/mcp-gateway'
import { DINERO_PROVIDER, config } from '../../../../lib/integrations/providers/dinero/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { integrationScopeGaps } from '../../../../lib/integrations/scope-drift'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

describe('Dinero provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('dinero')
		expect(config.displayName).toBe('Dinero')
	})

	it('signs in through Visma with PKCE, basic client auth and a refresh token', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://dinero.oauth.connect.visma.com/connect/authorize',
			)
			expect(config.auth.config.tokenUrl).toBe(
				'https://dinero.oauth.connect.visma.com/connect/token',
			)
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.tokenAuthMethod).toBe('client_secret_basic')
			expect(config.auth.config.clientIdEnv).toBe('DINERO_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('DINERO_CLIENT_SECRET')
			expect(config.auth.config.scopes).toEqual([
				'dinero_mcp:invoke_tools',
				'offline_access',
				'dineropublicapi:read',
				'dineropublicapi:write',
			])
		}
	})

	it('declares Dinero hosted server with a bearer token', () => {
		expect(config.mcp?.envKey).toBe('DINERO_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.dinero.dk',
			headers: { Authorization: 'Bearer ${DINERO_TOKEN}' },
		})
	})

	it('is registered, and a token that carries the scopes needs no reconnect', () => {
		expect(getProvider(DINERO_PROVIDER).config).toBe(config)
		expect(listProviders().map((p) => p.config.name)).toContain(DINERO_PROVIDER)
		expect(
			integrationScopeGaps(config, {
				scope: 'dinero_mcp:invoke_tools offline_access dineropublicapi:read dineropublicapi:write',
			}),
		).toEqual({ missing: [], needsReconnect: false })
	})

	it('is behind a flag that is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.DINERO,
		})
		expect(isFlagEnabled(actor, FLAGS.DINERO, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.DINERO, on)).toBe(true)
	})
})

describe('Dinero through the gateway', () => {
	it('is served by the gateway, so an agent never holds the token', () => {
		expect(GATEWAY_PROVIDERS.has(DINERO_PROVIDER)).toBe(true)
	})

	it('rewrites an entry for its server to the gateway', () => {
		const upstreams = new Map([[DINERO_PROVIDER, 'https://mcp.dinero.dk']])
		const { servers, rewritten } = rewriteMcpServersForGateway(
			{ dinero: { type: 'http', url: 'https://mcp.dinero.dk' } },
			upstreams,
		)
		expect(rewritten).toEqual(['dinero'])
		expect(servers?.dinero).toEqual(gatewayServerSpec(DINERO_PROVIDER))
	})

	it('sends the token as a bearer header', () => {
		expect(buildUpstreamHeaders(config.mcp?.server?.headers, 'DINERO_TOKEN', 'tok-1')).toEqual({
			Authorization: 'Bearer tok-1',
		})
	})

	it('treats a tool as a write unless the server marks it read-only', () => {
		for (const tool of ['CreatePurchaseVoucher', 'a_tool_added_later']) {
			expect(classifyTool(DINERO_PROVIDER, tool), tool).toBe('write')
		}
		expect(classifyTool(DINERO_PROVIDER, 'GetOrganizations', { readOnlyHint: true })).toBe('read')
	})
})
