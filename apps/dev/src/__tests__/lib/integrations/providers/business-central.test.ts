import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS, buildUpstreamHeaders } from '../../../../lib/integrations/mcp-gateway'
import {
	BUSINESS_CENTRAL_PROVIDER,
	config,
	parseTokenResponse,
} from '../../../../lib/integrations/providers/business-central/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { integrationScopeGaps } from '../../../../lib/integrations/scope-drift'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

const API_SCOPE = 'https://api.businesscentral.dynamics.com/Financials.ReadWrite.All'

describe('Business Central provider config', () => {
	it('signs in at Entra as a public client with PKCE, for the Business Central API scope', () => {
		expect(config.name).toBe('business-central')
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
			)
			expect(config.auth.config.tokenUrl).toBe(
				'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
			)
			expect(config.auth.config.scopes).toEqual(['offline_access', API_SCOPE])
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.tokenAuthMethod).toBe('none')
			expect(config.auth.config.clientIdEnv).toBe('BUSINESS_CENTRAL_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBeUndefined()
			// A single customer's own app is not used: Maskin's app is multitenant.
			expect(config.auth.config.customerApp).toBeUndefined()
		}
	})

	it('declares Microsoft’s server with a fixed environment and no tenant or company header', () => {
		expect(config.mcp?.envKey).toBe('BUSINESS_CENTRAL_TOKEN')
		expect(config.mcp?.autoInject).toBeUndefined()
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.businesscentral.dynamics.com',
			headers: {
				Authorization: 'Bearer ${BUSINESS_CENTRAL_TOKEN}',
				EnvironmentName: 'Production',
			},
		})
	})

	it('is registered and served through the gateway with the token filled in', () => {
		expect(getProvider(BUSINESS_CENTRAL_PROVIDER).config).toBe(config)
		expect(getProvider(BUSINESS_CENTRAL_PROVIDER).parseTokenResponse).toBe(parseTokenResponse)
		expect(listProviders().map((p) => p.config.name)).toContain(BUSINESS_CENTRAL_PROVIDER)
		expect(GATEWAY_PROVIDERS.has(BUSINESS_CENTRAL_PROVIDER)).toBe(true)
		expect(
			buildUpstreamHeaders(config.mcp?.server?.headers, 'BUSINESS_CENTRAL_TOKEN', 'tok'),
		).toEqual({ Authorization: 'Bearer tok', EnvironmentName: 'Production' })
	})
})

describe('Business Central token response', () => {
	it('adds offline_access back when a refresh token came with it, and nothing when complete', () => {
		expect(parseTokenResponse({ scope: API_SCOPE, refresh_token: 'r' })).toEqual({
			scope: `${API_SCOPE} offline_access`,
		})
		expect(
			parseTokenResponse({ scope: `${API_SCOPE} offline_access`, refresh_token: 'r' }),
		).toEqual({})
		expect(parseTokenResponse({ access_token: 'a' })).toEqual({})
		expect(parseTokenResponse(null)).toEqual({})
	})

	it('does not read a healthy connection as needing a reconnect', () => {
		const parsed = parseTokenResponse({ scope: API_SCOPE, refresh_token: 'r' })
		expect(integrationScopeGaps(config, { scope: parsed.scope })).toEqual({
			missing: [],
			needsReconnect: false,
		})
	})
})

describe('Business Central tool kinds', () => {
	const kind = (name: string, a?: { readOnlyHint?: boolean; destructiveHint?: boolean }) =>
		classifyTool(BUSINESS_CENTRAL_PROVIDER, name, a)

	it('lets a Read agent discover, describe and list', () => {
		for (const name of [
			'list_companies',
			'list_environments',
			'bc_actions_search',
			'bc_actions_describe',
			'bc_data_query',
			'List_Items_PAG30008',
			'List_Customers_PAG30009',
			'List_SalesOrders_PAG30028',
			'List_Something_QRY50100',
		]) {
			expect(kind(name)).toBe('read')
		}
	})

	it('treats invoke, every create, modify, delete and action tool, and unknown tools as writes', () => {
		for (const name of [
			'bc_actions_invoke',
			'Create_Item_PAG30008',
			'Modify_Customer_PAG30009',
			'Delete_Item_PAG30008',
			'Post_SalesInvoice_PAG30012',
			'a_tool_added_later',
			'List_Items',
			'List_Items_PAG30008_Delete',
		]) {
			expect(kind(name)).toBe('write')
		}
	})

	it('lets no annotation talk a tool into being a read, and a destructive hint win over a name', () => {
		expect(kind('bc_actions_invoke', { readOnlyHint: true })).toBe('write')
		expect(kind('List_Items_PAG30008', { destructiveHint: true })).toBe('write')
	})
})

describe('business-central-connect flag', () => {
	it('is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.BUSINESS_CENTRAL_CONNECT,
		})
		expect(FLAGS.BUSINESS_CENTRAL_CONNECT).toBe('business-central-connect')
		expect(isFlagEnabled(actor, FLAGS.BUSINESS_CENTRAL_CONNECT, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.BUSINESS_CENTRAL_CONNECT, on)).toBe(true)
	})
})
