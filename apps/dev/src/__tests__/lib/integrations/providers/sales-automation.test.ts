import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config as apollo } from '../../../../lib/integrations/providers/apollo/config'
import { config as calendly } from '../../../../lib/integrations/providers/calendly/config'
import { config as clay } from '../../../../lib/integrations/providers/clay/config'
import { config as gong } from '../../../../lib/integrations/providers/gong/config'
import { config as make } from '../../../../lib/integrations/providers/make/config'
import { config as monday } from '../../../../lib/integrations/providers/monday/config'
import { config as outreach } from '../../../../lib/integrations/providers/outreach/config'
import { SALES_AUTOMATION_PROVIDERS } from '../../../../lib/integrations/providers/sales-automation'
import { config as zoominfo } from '../../../../lib/integrations/providers/zoominfo/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

const CASES = [
	{
		config: apollo,
		authorizationUrl: 'https://mcp.apollo.io/mcp/oauth_metadata/redirect_to_authorize',
		tokenUrl: 'https://mcp.apollo.io/api/v1/oauth/token',
		mcpUrl: 'https://mcp.apollo.io/mcp',
		envKey: 'APOLLO_TOKEN',
		clientIdEnv: 'APOLLO_CLIENT_ID',
		clientSecretEnv: 'APOLLO_CLIENT_SECRET',
	},
	{
		config: zoominfo,
		authorizationUrl: 'https://mcp.zoominfo.com/oauth/authorize',
		tokenUrl: 'https://okta-login.zoominfo.com/oauth2/default/v1/token',
		mcpUrl: 'https://mcp.zoominfo.com/mcp',
		envKey: 'ZOOMINFO_TOKEN',
		clientIdEnv: 'ZOOMINFO_CLIENT_ID',
		clientSecretEnv: 'ZOOMINFO_CLIENT_SECRET',
	},
	{
		config: outreach,
		authorizationUrl: 'https://api.outreach.io/mcpOAuth/authorize',
		tokenUrl: 'https://api.outreach.io/mcpOAuth/token',
		mcpUrl: 'https://api.outreach.io/mcp',
		envKey: 'OUTREACH_TOKEN',
		clientIdEnv: 'OUTREACH_CLIENT_ID',
		clientSecretEnv: 'OUTREACH_CLIENT_SECRET',
	},
	{
		config: gong,
		authorizationUrl: 'https://app.gong.io/oauth2/authorize',
		tokenUrl: 'https://app.gong.io/oauth2/generate-mcp-token',
		mcpUrl: 'https://mcp.gong.io/mcp',
		envKey: 'GONG_TOKEN',
		clientIdEnv: 'GONG_CLIENT_ID',
		clientSecretEnv: 'GONG_CLIENT_SECRET',
	},
	{
		config: clay,
		authorizationUrl: 'https://app.clay.com/oauth/authorize',
		tokenUrl: 'https://api.clay.com/oauth/token',
		mcpUrl: 'https://api.clay.com/v3/mcp',
		envKey: 'CLAY_TOKEN',
		clientIdEnv: 'CLAY_CLIENT_ID',
		clientSecretEnv: 'CLAY_CLIENT_SECRET',
	},
	{
		config: calendly,
		authorizationUrl: 'https://calendly.com/oauth/authorize',
		tokenUrl: 'https://calendly.com/oauth/token',
		mcpUrl: 'https://mcp.calendly.com',
		envKey: 'CALENDLY_TOKEN',
		clientIdEnv: 'CALENDLY_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		config: monday,
		authorizationUrl: 'https://auth.monday.com/oauth2/authorize',
		tokenUrl: 'https://auth.monday.com/oauth_ms/oauth/token',
		mcpUrl: 'https://mcp.monday.com/mcp',
		envKey: 'MONDAY_TOKEN',
		clientIdEnv: 'MONDAY_CLIENT_ID',
		clientSecretEnv: 'MONDAY_CLIENT_SECRET',
	},
	{
		config: make,
		authorizationUrl: 'https://www.make.com/oauth/v2/authorize',
		tokenUrl: 'https://www.make.com/oauth/v2/token',
		mcpUrl: 'https://mcp.make.com/v2',
		envKey: 'MAKE_TOKEN',
		clientIdEnv: 'MAKE_CLIENT_ID',
		clientSecretEnv: 'MAKE_CLIENT_SECRET',
	},
]

describe.each(CASES)('$config.displayName provider config', (c) => {
	it('signs in at the vendor with PKCE and the vendor-published client env vars', () => {
		expect(c.config.auth.type).toBe('oauth2')
		if (c.config.auth.type === 'oauth2') {
			expect(c.config.auth.config.authorizationUrl).toBe(c.authorizationUrl)
			expect(c.config.auth.config.tokenUrl).toBe(c.tokenUrl)
			expect(c.config.auth.config.pkce).toBe(true)
			expect(c.config.auth.config.clientIdEnv).toBe(c.clientIdEnv)
			expect(c.config.auth.config.clientSecretEnv).toBe(c.clientSecretEnv)
		}
	})

	it('declares the hosted MCP server with a bearer token', () => {
		expect(c.config.mcp?.envKey).toBe(c.envKey)
		expect(c.config.mcp?.autoInject).toBeUndefined()
		expect(c.config.mcp?.server).toEqual({
			type: 'http',
			url: c.mcpUrl,
			headers: { Authorization: `Bearer \${${c.envKey}}` },
		})
	})

	it('is registered and served by the gateway', () => {
		expect(getProvider(c.config.name).config).toBe(c.config)
		expect(listProviders().map((p) => p.config.name)).toContain(c.config.name)
		expect(GATEWAY_PROVIDERS.has(c.config.name)).toBe(true)
	})

	it('treats a tool as a write unless the server marks it read-only', () => {
		expect(classifyTool(c.config.name, 'delete_record')).toBe('write')
		expect(classifyTool(c.config.name, 'a_tool_added_later')).toBe('write')
		expect(classifyTool(c.config.name, 'a_tool_added_later', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool(c.config.name, 'get_record', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})

describe('scopes', () => {
	const scopesOf = (config: typeof apollo) =>
		config.auth.type === 'oauth2' ? config.auth.config.scopes : []

	it('asks Gong and Calendly for their read scopes only', () => {
		expect(scopesOf(gong)).toEqual(['mcp:read'])
		expect(scopesOf(calendly)).toEqual(['mcp:scheduling:read', 'mcp:notetaker:read'])
	})

	it('asks Apollo for no scope that writes, sends or spends on a purchase', () => {
		const scopes = scopesOf(apollo)
		expect(scopes).toContain('mcp_scope')
		for (const scope of scopes) {
			expect(scope, scope).not.toMatch(
				/(_write|_create|_update|_send_now|_approve|_purchase|_add_|_remove_|_deduplicate|_bulk_create)/,
			)
		}
	})

	it('leaves the scope choice to the sign-in screen for monday.com and Make', () => {
		expect(scopesOf(monday)).toEqual([])
		expect(scopesOf(make)).toEqual([])
	})
})

describe('public clients and tile text', () => {
	it('Calendly uses no token auth method and no revocation endpoint', () => {
		if (calendly.auth.type === 'oauth2') {
			expect(calendly.auth.config.tokenAuthMethod).toBe('none')
			expect(calendly.auth.config.revokeUrl).toBeUndefined()
		}
	})

	it('says in the tile text what the customer must switch on first', () => {
		expect(outreach.description).toContain('Amplify')
		expect(gong.description).toContain('admin')
		expect(monday.description).toContain('admin')
		expect(zoominfo.description).toContain('subscription')
	})
})

describe('sales-automation flag', () => {
	it('lists exactly the eight providers', () => {
		expect([...SALES_AUTOMATION_PROVIDERS].sort()).toEqual([
			'apollo',
			'calendly',
			'clay',
			'gong',
			'make',
			'monday',
			'outreach',
			'zoominfo',
		])
	})

	it('is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.SALES_AUTOMATION_INTEGRATIONS,
		})
		expect(isFlagEnabled(actor, FLAGS.SALES_AUTOMATION_INTEGRATIONS, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.SALES_AUTOMATION_INTEGRATIONS, on)).toBe(true)
	})
})
