import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config as cloudflare } from '../../../../lib/integrations/providers/cloudflare/config'
import { config as datadog } from '../../../../lib/integrations/providers/datadog/config'
import { DEVELOPER_DATA_PROVIDERS } from '../../../../lib/integrations/providers/developer-data'
import { config as hex } from '../../../../lib/integrations/providers/hex/config'
import { config as neon } from '../../../../lib/integrations/providers/neon/config'
import { config as netlify } from '../../../../lib/integrations/providers/netlify/config'
import { config as newRelic } from '../../../../lib/integrations/providers/new-relic/config'
import { config as pagerduty } from '../../../../lib/integrations/providers/pagerduty/config'
import { config as planetscale } from '../../../../lib/integrations/providers/planetscale/config'
import { config as retool } from '../../../../lib/integrations/providers/retool/config'
import { config as supabase } from '../../../../lib/integrations/providers/supabase/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

const CASES = [
	{
		config: cloudflare,
		authorizationUrl: 'https://mcp.cloudflare.com/authorize',
		tokenUrl: 'https://mcp.cloudflare.com/token',
		scopes: ['user:read', 'account:read'],
		mcpUrl: 'https://mcp.cloudflare.com/mcp',
		env: 'CLOUDFLARE',
		public: true,
	},
	{
		config: supabase,
		authorizationUrl: 'https://api.supabase.com/v1/oauth/authorize',
		tokenUrl: 'https://api.supabase.com/v1/oauth/token',
		scopes: [
			'organizations:read',
			'projects:read',
			'database:read',
			'analytics:read',
			'edge_functions:read',
			'environment:read',
			'storage:read',
		],
		mcpUrl: 'https://mcp.supabase.com/mcp',
		env: 'SUPABASE',
		public: false,
	},
	{
		config: neon,
		authorizationUrl: 'https://mcp.neon.tech/api/authorize',
		tokenUrl: 'https://mcp.neon.tech/api/token',
		scopes: ['read'],
		mcpUrl: 'https://mcp.neon.tech/mcp',
		env: 'NEON',
		public: true,
	},
	{
		config: planetscale,
		authorizationUrl: 'https://app.planetscale.com/oauth/authorize',
		tokenUrl: 'https://auth.planetscale.com/oauth/token',
		scopes: ['read_organizations', 'read_databases'],
		mcpUrl: 'https://mcp.pscale.dev/mcp/planetscale',
		env: 'PLANETSCALE',
		public: false,
	},
	{
		config: netlify,
		authorizationUrl: 'https://mcp.netlify.com/oauth-server/auth',
		tokenUrl: 'https://mcp.netlify.com/oauth-server/token',
		scopes: ['read', 'offline_access'],
		mcpUrl: 'https://mcp.netlify.com/mcp',
		env: 'NETLIFY',
		public: true,
	},
	{
		config: datadog,
		authorizationUrl: 'https://app.datadoghq.com/oauth2/v1/authorize',
		tokenUrl: 'https://app.datadoghq.com/api/v2/oauth2/token',
		scopes: ['mcp_all'],
		mcpUrl: 'https://mcp.datadoghq.com/v1/mcp',
		env: 'DATADOG',
		public: true,
	},
	{
		config: newRelic,
		authorizationUrl: 'https://oauth2.service.newrelic.com/oauth2/auth',
		tokenUrl: 'https://oauth2.service.newrelic.com/oauth2/token',
		scopes: ['observability:read', 'offline_access'],
		mcpUrl: 'https://mcp.newrelic.com/mcp/',
		env: 'NEW_RELIC',
		public: true,
	},
	{
		config: pagerduty,
		authorizationUrl: 'https://app.pagerduty.com/global/oauth/authorize',
		tokenUrl: 'https://app.pagerduty.com/global/oauth/token',
		scopes: ['read'],
		mcpUrl: 'https://mcp.pagerduty.com/mcp',
		env: 'PAGERDUTY',
		public: true,
	},
	{
		config: retool,
		authorizationUrl: 'https://mcp.retool.com/auth/oauth2/authorize',
		tokenUrl: 'https://mcp.retool.com/api/oauth2/token',
		scopes: ['mcp:read'],
		mcpUrl: 'https://mcp.retool.com/mcp',
		env: 'RETOOL',
		public: true,
	},
	{
		config: hex,
		authorizationUrl: 'https://auth.app.hex.tech/oauth2/authorize',
		tokenUrl: 'https://auth.app.hex.tech/oauth2/token',
		scopes: ['openid', 'profile', 'email', 'offline_access'],
		mcpUrl: 'https://app.hex.tech/mcp',
		env: 'HEX',
		public: true,
	},
]

describe.each(CASES)('$config.displayName provider config', (c) => {
	it('signs in at the vendor with PKCE and asks for its read scopes', () => {
		expect(c.config.auth.type).toBe('oauth2')
		if (c.config.auth.type === 'oauth2') {
			expect(c.config.auth.config.authorizationUrl).toBe(c.authorizationUrl)
			expect(c.config.auth.config.tokenUrl).toBe(c.tokenUrl)
			expect(c.config.auth.config.pkce).toBe(true)
			expect(c.config.auth.config.scopes).toEqual(c.scopes)
			expect(c.config.auth.config.clientIdEnv).toBe(`${c.env}_CLIENT_ID`)
		}
	})

	it('uses a public client with no secret only where the vendor offers one', () => {
		if (c.config.auth.type === 'oauth2') {
			expect(c.config.auth.config.tokenAuthMethod).toBe(c.public ? 'none' : undefined)
			expect(c.config.auth.config.clientSecretEnv).toBe(
				c.public ? undefined : `${c.env}_CLIENT_SECRET`,
			)
		}
	})

	it('declares the hosted MCP server with a bearer token', () => {
		expect(c.config.mcp?.envKey).toBe(`${c.env}_TOKEN`)
		expect(c.config.mcp?.autoInject).toBeUndefined()
		expect(c.config.mcp?.server).toEqual({
			type: 'http',
			url: c.mcpUrl,
			headers: { Authorization: `Bearer \${${c.env}_TOKEN}` },
		})
	})

	it('is registered and served by the gateway', () => {
		expect(getProvider(c.config.name).config).toBe(c.config)
		expect(listProviders().map((p) => p.config.name)).toContain(c.config.name)
		expect(GATEWAY_PROVIDERS.has(c.config.name)).toBe(true)
	})

	it('treats a tool as a write unless the server marks it read-only', () => {
		expect(classifyTool(c.config.name, 'delete_project')).toBe('write')
		expect(classifyTool(c.config.name, 'a_tool_added_later')).toBe('write')
		expect(classifyTool(c.config.name, 'a_tool_added_later', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool(c.config.name, 'list_projects', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})

describe('developer-data flag', () => {
	it('lists exactly the ten providers', () => {
		expect([...DEVELOPER_DATA_PROVIDERS].sort()).toEqual(CASES.map((c) => c.config.name).sort())
	})

	it('is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.DEVELOPER_DATA_INTEGRATIONS,
		})
		expect(isFlagEnabled(actor, FLAGS.DEVELOPER_DATA_INTEGRATIONS, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.DEVELOPER_DATA_INTEGRATIONS, on)).toBe(true)
	})
})
