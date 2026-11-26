import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config as asana } from '../../../../lib/integrations/providers/asana/config'
import { config as docusign } from '../../../../lib/integrations/providers/docusign/config'
import { config as dropbox } from '../../../../lib/integrations/providers/dropbox/config'
import { config as figma } from '../../../../lib/integrations/providers/figma/config'
import { config as hubspot } from '../../../../lib/integrations/providers/hubspot/config'
import { config as intercom } from '../../../../lib/integrations/providers/intercom/config'
import { OWN_APP_PROVIDERS, appIdIsSet } from '../../../../lib/integrations/providers/own-app'
import { config as pipedrive } from '../../../../lib/integrations/providers/pipedrive/config'
import { config as ramp } from '../../../../lib/integrations/providers/ramp/config'
import { config as squarespace } from '../../../../lib/integrations/providers/squarespace/config'
import { config as xero } from '../../../../lib/integrations/providers/xero/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'
import type { ProviderConfig } from '../../../../lib/integrations/types'

// Sign-in addresses and server addresses are from each vendor's published metadata, checked 22 Nov 2026.
const CASES = [
	{
		config: hubspot,
		authorizationUrl: 'https://mcp.hubspot.com/oauth/authorize/user',
		tokenUrl: 'https://mcp.hubspot.com/oauth/v3/token',
		mcpUrl: 'https://mcp.hubspot.com',
		envKey: 'HUBSPOT_TOKEN',
		clientIdEnv: 'HUBSPOT_CLIENT_ID',
		clientSecretEnv: 'HUBSPOT_CLIENT_SECRET',
	},
	{
		config: asana,
		authorizationUrl: 'https://app.asana.com/-/oauth_authorize',
		tokenUrl: 'https://app.asana.com/-/oauth_token',
		mcpUrl: 'https://mcp.asana.com/v2/mcp',
		envKey: 'ASANA_TOKEN',
		clientIdEnv: 'ASANA_CLIENT_ID',
		clientSecretEnv: 'ASANA_CLIENT_SECRET',
	},
	{
		config: docusign,
		authorizationUrl: 'https://account.docusign.com/oauth/auth',
		tokenUrl: 'https://account.docusign.com/oauth/token',
		mcpUrl: 'https://mcp.docusign.com/mcp',
		envKey: 'DOCUSIGN_TOKEN',
		clientIdEnv: 'DOCUSIGN_CLIENT_ID',
		clientSecretEnv: 'DOCUSIGN_CLIENT_SECRET',
	},
	{
		config: figma,
		authorizationUrl: 'https://www.figma.com/oauth/mcp',
		tokenUrl: 'https://api.figma.com/v1/oauth/token',
		mcpUrl: 'https://mcp.figma.com/mcp',
		envKey: 'FIGMA_TOKEN',
		clientIdEnv: 'FIGMA_CLIENT_ID',
		clientSecretEnv: 'FIGMA_CLIENT_SECRET',
	},
	{
		config: dropbox,
		authorizationUrl: 'https://www.dropbox.com/oauth2/authorize',
		tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
		mcpUrl: 'https://mcp.dropbox.com/mcp',
		envKey: 'DROPBOX_TOKEN',
		clientIdEnv: 'DROPBOX_CLIENT_ID',
		clientSecretEnv: 'DROPBOX_CLIENT_SECRET',
	},
	{
		config: intercom,
		authorizationUrl: 'https://mcp.intercom.com/authorize',
		tokenUrl: 'https://mcp.intercom.com/token',
		mcpUrl: 'https://mcp.intercom.com/mcp',
		envKey: 'INTERCOM_TOKEN',
		clientIdEnv: 'INTERCOM_CLIENT_ID',
		clientSecretEnv: 'INTERCOM_CLIENT_SECRET',
	},
	{
		config: pipedrive,
		authorizationUrl: 'https://oauth.pipedrive.com/oauth/authorize',
		tokenUrl: 'https://oauth.pipedrive.com/oauth/token',
		mcpUrl: 'https://mcp.pipedrive.ai/mcp',
		envKey: 'PIPEDRIVE_TOKEN',
		clientIdEnv: 'PIPEDRIVE_CLIENT_ID',
		clientSecretEnv: 'PIPEDRIVE_CLIENT_SECRET',
	},
	{
		config: ramp,
		authorizationUrl: 'https://mcp.ramp.com/oauth/authorize?auth_level=auto',
		tokenUrl: 'https://api.ramp.com/developer/v1/token/pkce',
		mcpUrl: 'https://mcp.ramp.com/mcp',
		envKey: 'RAMP_TOKEN',
		clientIdEnv: 'RAMP_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		config: squarespace,
		authorizationUrl: 'https://login.squarespace.com/api/1/login/oauth/provider/authorize',
		tokenUrl: 'https://login.squarespace.com/api/1/login/oauth/provider/tokens',
		mcpUrl: 'https://mcp.squarespace.com/mcp',
		envKey: 'SQUARESPACE_TOKEN',
		clientIdEnv: 'SQUARESPACE_CLIENT_ID',
		clientSecretEnv: 'SQUARESPACE_CLIENT_SECRET',
	},
	{
		config: xero,
		authorizationUrl: 'https://login.xero.com/identity/connect/authorize',
		tokenUrl: 'https://identity.xero.com/connect/token',
		mcpUrl: 'https://api.xero.com/mcp/v1',
		envKey: 'XERO_TOKEN',
		clientIdEnv: 'XERO_CLIENT_ID',
		clientSecretEnv: 'XERO_CLIENT_SECRET',
	},
]

const scopesOf = (config: ProviderConfig) =>
	config.auth.type === 'oauth2' ? config.auth.config.scopes : []

describe.each(CASES)('$config.displayName provider config', (c) => {
	it('signs in at the vendor with PKCE and its own client env vars', () => {
		expect(c.config.auth.type).toBe('oauth2')
		if (c.config.auth.type === 'oauth2') {
			expect(c.config.auth.config.authorizationUrl).toBe(c.authorizationUrl)
			expect(c.config.auth.config.tokenUrl).toBe(c.tokenUrl)
			expect(c.config.auth.config.pkce).toBe(true)
			expect(c.config.auth.config.clientIdEnv).toBe(c.clientIdEnv)
			expect(c.config.auth.config.clientSecretEnv).toBe(c.clientSecretEnv)
		}
	})

	it('declares the vendor hosted MCP server with a bearer token', () => {
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
	})

	it('has a secret exactly when its token auth method is not none', () => {
		if (c.config.auth.type !== 'oauth2') throw new Error('not oauth2')
		const { tokenAuthMethod, clientSecretEnv } = c.config.auth.config
		expect(tokenAuthMethod === 'none').toBe(clientSecretEnv === undefined)
	})
})

describe('scopes', () => {
	it('asks Ramp for read scopes only, and for no card number or bank account scope', () => {
		const scopes = scopesOf(ramp)
		expect(scopes.length).toBeGreaterThan(0)
		for (const scope of scopes) {
			expect(scope, scope).toMatch(/:read$/)
			expect(scope, scope).not.toMatch(/agent|bank_accounts|audit_logs|treasury/)
		}
	})

	it('asks Xero for read scopes and the refresh token only', () => {
		for (const scope of scopesOf(xero)) {
			expect(scope, scope).toMatch(/^(offline_access|accounting\..*\.read)$/)
		}
		expect(scopesOf(xero)).toContain('offline_access')
	})

	it('asks Dropbox for read scopes only and a refresh token', () => {
		for (const scope of scopesOf(dropbox)) expect(scope, scope).toMatch(/\.read$/)
		expect(
			dropbox.auth.type === 'oauth2' && dropbox.auth.config.extraAuthParams?.token_access_type,
		).toBe('offline')
	})

	it('asks Pipedrive for no mail, mail-sending, projects or admin scope', () => {
		for (const scope of scopesOf(pipedrive)) {
			expect(scope, scope).not.toMatch(/^(mail|admin|project)/)
		}
	})

	it('asks DocuSign for none of the write or manage scopes', () => {
		expect(scopesOf(docusign)).toEqual(['signature', 'spring_read', 'adm_store_unified_repo_read'])
	})

	it('leaves the scope choice to the vendor app for HubSpot', () => {
		expect(scopesOf(hubspot)).toEqual([])
	})
})

describe('tile text', () => {
	it('says what the vendor must do first', () => {
		for (const c of [figma, dropbox, squarespace, pipedrive]) {
			expect(c.description, c.name).toContain('approve')
		}
		expect(docusign.description).toContain('allow')
		expect(intercom.description).toContain('allow')
		expect(ramp.description).toContain('allow')
	})
})

describe('own-app flag and app id gate', () => {
	it('lists exactly the ten providers', () => {
		expect([...OWN_APP_PROVIDERS].sort()).toEqual([
			'asana',
			'docusign',
			'dropbox',
			'figma',
			'hubspot',
			'intercom',
			'pipedrive',
			'ramp',
			'squarespace',
			'xero',
		])
	})

	it('is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.OWN_APP_INTEGRATIONS,
		})
		expect(isFlagEnabled(actor, FLAGS.OWN_APP_INTEGRATIONS, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.OWN_APP_INTEGRATIONS, on)).toBe(true)
	})

	it('treats an unset or blank app id as not set', () => {
		expect(appIdIsSet('RAMP_CLIENT_ID', {})).toBe(false)
		expect(appIdIsSet('RAMP_CLIENT_ID', { RAMP_CLIENT_ID: '' })).toBe(false)
		expect(appIdIsSet('RAMP_CLIENT_ID', { RAMP_CLIENT_ID: '   ' })).toBe(false)
		expect(appIdIsSet('RAMP_CLIENT_ID', { RAMP_CLIENT_ID: 'abc' })).toBe(true)
	})
})
