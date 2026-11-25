import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { WORK_INTEGRATIONS_PROVIDERS } from '../../../../lib/integrations/providers/work-integrations'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

const CASES = [
	{
		name: 'klaviyo',
		displayName: 'Klaviyo',
		authorizationUrl: 'https://mcp.klaviyo.com/authorize',
		tokenUrl: 'https://mcp.klaviyo.com/token',
		scopes: [],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.klaviyo.com/mcp',
		envKey: 'KLAVIYO_TOKEN',
		clientIdEnv: 'KLAVIYO_CLIENT_ID',
		clientSecretEnv: 'KLAVIYO_CLIENT_SECRET',
	},
	{
		name: 'mailchimp',
		displayName: 'Mailchimp',
		authorizationUrl: 'https://ai-inc.mailchimp.com/claude/oauth/authorize',
		tokenUrl: 'https://ai-inc.mailchimp.com/claude/oauth/token',
		scopes: ['mailchimp'],
		tokenAuthMethod: 'none',
		extraAuthParams: undefined,
		mcpUrl: 'https://ai-inc.mailchimp.com/claude/mcp/v2',
		envKey: 'MAILCHIMP_TOKEN',
		clientIdEnv: 'MAILCHIMP_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		name: 'brevo',
		displayName: 'Brevo',
		authorizationUrl: 'https://mcp.brevo.com/oauth/authorize',
		tokenUrl: 'https://mcp.brevo.com/oauth/token',
		scopes: ['all'],
		tokenAuthMethod: 'none',
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.brevo.com/v1/brevo/mcp',
		envKey: 'BREVO_TOKEN',
		clientIdEnv: 'BREVO_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		name: 'mercury',
		displayName: 'Mercury',
		authorizationUrl: 'https://mcp.mercury.com/authorize',
		tokenUrl: 'https://mcp.mercury.com/token',
		scopes: ['read', 'offline_access'],
		tokenAuthMethod: 'client_secret_basic',
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.mercury.com/mcp',
		envKey: 'MERCURY_TOKEN',
		clientIdEnv: 'MERCURY_CLIENT_ID',
		clientSecretEnv: 'MERCURY_CLIENT_SECRET',
	},
	{
		name: 'brex',
		displayName: 'Brex',
		authorizationUrl: 'https://accounts-api.brex.com/oauth2/default/v1/authorize',
		tokenUrl: 'https://accounts-api.brex.com/oauth2/default/v1/token',
		scopes: [
			'openid',
			'offline_access',
			'email',
			'users.readonly',
			'departments.readonly',
			'locations.readonly',
			'titles.readonly',
			'legal_entities.readonly',
			'cards.readonly',
			'companies.readonly',
			'budgets.readonly',
			'travel.trips.readonly',
			'expenses.card.readonly',
			'audit_logs.readonly',
			'accounts.cash.readonly',
			'vendors.readonly',
			'tasks.readonly',
			'billing_groups.readonly',
			'accounting.integration.read',
			'accounting.record.read',
			'fields.read',
			'field_values.read',
		],
		tokenAuthMethod: undefined,
		extraAuthParams: { prompt: 'consent' },
		mcpUrl: 'https://api.brex.com/mcp',
		envKey: 'BREX_TOKEN',
		clientIdEnv: 'BREX_CLIENT_ID',
		clientSecretEnv: 'BREX_CLIENT_SECRET',
	},
	{
		name: 'gusto',
		displayName: 'Gusto',
		authorizationUrl: 'https://mcp.api.gusto.com/oauth/authorize',
		tokenUrl: 'https://mcp.api.gusto.com/oauth/token',
		scopes: [
			'public',
			'companies:read',
			'employees:read',
			'contractors:read',
			'departments:read',
			'employments:read',
			'jobs:read',
			'pay_schedules:read',
			'payrolls:read',
			'compensations:read',
			'employee_benefits:read',
			'time_off_policies:read',
			'time_off_requests:read',
			'time_sheet:read',
		],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.api.gusto.com',
		envKey: 'GUSTO_TOKEN',
		clientIdEnv: 'GUSTO_CLIENT_ID',
		clientSecretEnv: 'GUSTO_CLIENT_SECRET',
	},
	{
		name: 'deel',
		displayName: 'Deel',
		authorizationUrl: 'https://api.letsdeel.com/oauth/authorize',
		tokenUrl: 'https://api.letsdeel.com/oauth/tokens',
		scopes: [
			'organizations:read',
			'people:read',
			'contracts:read',
			'jobs:read',
			'groups:read',
			'legal-entity:read',
			'global-payroll:read',
			'payments:read',
			'accounting:read',
			'benefits:read',
			'time-off:read',
			'timesheets:read',
			'approvals:read',
			'tasks:read',
			'worker:read',
		],
		tokenAuthMethod: 'none',
		extraAuthParams: undefined,
		mcpUrl: 'https://api.letsdeel.com/mcp',
		envKey: 'DEEL_TOKEN',
		clientIdEnv: 'DEEL_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		name: 'greenhouse',
		displayName: 'Greenhouse',
		authorizationUrl: 'https://auth.greenhouse.io/authorize',
		tokenUrl: 'https://auth.greenhouse.io/token',
		scopes: ['greenhouse:mcp_client'],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.greenhouse.io/mcp',
		envKey: 'GREENHOUSE_TOKEN',
		clientIdEnv: 'GREENHOUSE_CLIENT_ID',
		clientSecretEnv: 'GREENHOUSE_CLIENT_SECRET',
	},
	{
		name: 'vanta',
		displayName: 'Vanta',
		authorizationUrl: 'https://app.vanta.com/oauth/authorize',
		tokenUrl: 'https://api.vanta.com/oauth/token',
		scopes: ['mcp-api.all:write'],
		tokenAuthMethod: 'none',
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.vanta.com/mcp',
		envKey: 'VANTA_TOKEN',
		clientIdEnv: 'VANTA_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		name: 'drata',
		displayName: 'Drata',
		authorizationUrl: 'https://mcp.drata.com/auth0-proxy/authorize',
		tokenUrl: 'https://drata-prod.us.auth0.com/oauth/token',
		scopes: [
			'openid',
			'profile',
			'email',
			'offline_access',
			'read:controls',
			'read:monitor-test',
			'read:monitor-test-failure',
			'read:monitor-test-pass',
			'read:compliance-check-exclusion',
			'read:monitor-test-exclusion',
			'read:policy',
			'read:assigned-policies',
			'read:risk',
			'read:risk-registers',
			'read:workspace',
			'read:company',
			'read:users',
			'read:user',
			'read:framework',
			'read:evidence',
			'read:vendor',
			'read:vendor-security-review',
			'read:vendor-document',
			'read:personnel',
			'read:device',
			'read:custom-task',
		],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.drata.com/mcp/',
		envKey: 'DRATA_TOKEN',
		clientIdEnv: 'DRATA_CLIENT_ID',
		clientSecretEnv: 'DRATA_CLIENT_SECRET',
	},
	{
		name: 'trello',
		displayName: 'Trello',
		authorizationUrl: 'https://auth.atlassian.com/authorize',
		tokenUrl: 'https://auth.atlassian.com/oauth/token',
		scopes: [
			'offline_access',
			'read:me',
			'read:account',
			'read:board:trello',
			'write:board:trello',
			'read:organization:trello',
			'write:organization:trello',
			'read:member:trello',
		],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.trello.com/v1',
		envKey: 'TRELLO_TOKEN',
		clientIdEnv: 'TRELLO_CLIENT_ID',
		clientSecretEnv: 'TRELLO_CLIENT_SECRET',
	},
	{
		name: 'mural',
		displayName: 'Mural',
		authorizationUrl: 'https://mcp-canvas.mural.co/authorize',
		tokenUrl: 'https://mcp-canvas.mural.co/token',
		scopes: ['murals:read', 'murals:write', 'rooms:read', 'workspaces:read'],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp-canvas.mural.co/mcp',
		envKey: 'MURAL_TOKEN',
		clientIdEnv: 'MURAL_CLIENT_ID',
		clientSecretEnv: 'MURAL_CLIENT_SECRET',
	},
	{
		name: 'framer',
		displayName: 'Framer',
		authorizationUrl: 'https://api.framer.com/auth/oauth/authorize',
		tokenUrl: 'https://api.framer.com/auth/oauth/token',
		scopes: ['mcp:project'],
		tokenAuthMethod: 'none',
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.framer.com/mcp',
		envKey: 'FRAMER_TOKEN',
		clientIdEnv: 'FRAMER_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		name: 'wix',
		displayName: 'Wix',
		authorizationUrl: 'https://mcp.wix.com/authorize',
		tokenUrl: 'https://mcp.wix.com/token',
		scopes: ['offline_access'],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.wix.com/mcp',
		envKey: 'WIX_TOKEN',
		clientIdEnv: 'WIX_CLIENT_ID',
		clientSecretEnv: 'WIX_CLIENT_SECRET',
	},
	{
		name: 'coda',
		displayName: 'Coda',
		authorizationUrl: 'https://coda.io/v4/api/oauth2/authorize',
		tokenUrl: 'https://coda.io/v4/api/oauth2/token',
		scopes: ['mcp:all'],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://coda.io/apis/mcp',
		envKey: 'CODA_TOKEN',
		clientIdEnv: 'CODA_CLIENT_ID',
		clientSecretEnv: 'CODA_CLIENT_SECRET',
	},
	{
		name: 'freshbooks',
		displayName: 'FreshBooks',
		authorizationUrl: 'https://auth.freshbooks.com/service/auth/oauth/authorize',
		tokenUrl: 'https://auth.freshbooks.com/service/auth/oauth/token',
		scopes: ['mcp:all:read', 'offline_access'],
		tokenAuthMethod: undefined,
		extraAuthParams: undefined,
		mcpUrl: 'https://mcp.freshbooks.com/v1',
		envKey: 'FRESHBOOKS_TOKEN',
		clientIdEnv: 'FRESHBOOKS_CLIENT_ID',
		clientSecretEnv: 'FRESHBOOKS_CLIENT_SECRET',
	},
]

describe.each(CASES)('$displayName provider config', (c) => {
	const config = getProvider(c.name).config

	it('has the right name and display name', () => {
		expect(config.name).toBe(c.name)
		expect(config.displayName).toBe(c.displayName)
	})

	it('signs in at the vendor with PKCE and asks for its scopes', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(c.authorizationUrl)
			expect(config.auth.config.tokenUrl).toBe(c.tokenUrl)
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toEqual(c.scopes)
			expect(config.auth.config.tokenAuthMethod).toBe(c.tokenAuthMethod)
			expect(config.auth.config.extraAuthParams).toEqual(c.extraAuthParams)
			expect(config.auth.config.clientIdEnv).toBe(c.clientIdEnv)
			expect(config.auth.config.clientSecretEnv).toBe(c.clientSecretEnv)
		}
	})

	it('declares the hosted MCP server with a bearer token', () => {
		expect(config.mcp?.envKey).toBe(c.envKey)
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: c.mcpUrl,
			headers: { Authorization: `Bearer \${${c.envKey}}` },
		})
	})

	it('is registered and served by the gateway', () => {
		expect(listProviders().map((p) => p.config.name)).toContain(c.name)
		expect(GATEWAY_PROVIDERS.has(c.name)).toBe(true)
	})

	it('treats a tool as a write unless the server marks it read-only', () => {
		expect(classifyTool(c.name, 'delete_record')).toBe('write')
		expect(classifyTool(c.name, 'a_tool_added_later')).toBe('write')
		expect(classifyTool(c.name, 'a_tool_added_later', { readOnlyHint: true })).toBe('read')
		expect(classifyTool(c.name, 'get_record', { readOnlyHint: true, destructiveHint: true })).toBe(
			'write',
		)
	})
})

describe('work-integrations flag', () => {
	it('lists exactly the sixteen providers', () => {
		expect([...WORK_INTEGRATIONS_PROVIDERS].sort()).toEqual(CASES.map((c) => c.name).sort())
	})

	it('is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.WORK_INTEGRATIONS,
		})
		expect(isFlagEnabled(actor, FLAGS.WORK_INTEGRATIONS, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.WORK_INTEGRATIONS, on)).toBe(true)
	})
})
