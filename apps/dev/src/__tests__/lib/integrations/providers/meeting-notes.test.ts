import { describe, expect, it } from 'vitest'
import { FLAGS, isFlagEnabled, parseFeatureFlagConfig } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config as fathom } from '../../../../lib/integrations/providers/fathom/config'
import { config as fireflies } from '../../../../lib/integrations/providers/fireflies/config'
import { config as granola } from '../../../../lib/integrations/providers/granola/config'
import { MEETING_NOTES_PROVIDERS } from '../../../../lib/integrations/providers/meeting-notes'
import { config as otter } from '../../../../lib/integrations/providers/otter/config'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

const CASES = [
	{
		config: fireflies,
		authorizationUrl: 'https://api.fireflies.ai/authorize',
		tokenUrl: 'https://api.fireflies.ai/token',
		scopes: ['profile', 'email'],
		mcpUrl: 'https://api.fireflies.ai/mcp',
		envKey: 'FIREFLIES_TOKEN',
		clientIdEnv: 'FIREFLIES_CLIENT_ID',
		clientSecretEnv: 'FIREFLIES_CLIENT_SECRET',
	},
	{
		config: granola,
		authorizationUrl: 'https://mcp-auth.granola.ai/oauth2/authorize',
		tokenUrl: 'https://mcp-auth.granola.ai/oauth2/token',
		scopes: ['openid', 'profile', 'email', 'offline_access'],
		mcpUrl: 'https://mcp.granola.ai/mcp',
		envKey: 'GRANOLA_TOKEN',
		clientIdEnv: 'GRANOLA_CLIENT_ID',
		clientSecretEnv: 'GRANOLA_CLIENT_SECRET',
	},
	{
		config: fathom,
		authorizationUrl: 'https://fathom.video/mcp/oauth/authorize',
		tokenUrl: 'https://api.fathom.ai/mcp/oauth/token',
		scopes: ['mcp'],
		mcpUrl: 'https://api.fathom.ai/mcp',
		envKey: 'FATHOM_TOKEN',
		clientIdEnv: 'FATHOM_CLIENT_ID',
		clientSecretEnv: undefined,
	},
	{
		config: otter,
		authorizationUrl: 'https://otter.ai/oauth2/authorize',
		tokenUrl: 'https://otter.ai/oauth/token',
		scopes: ['profile:read', 'conversations:read'],
		mcpUrl: 'https://mcp.otter.ai/mcp',
		envKey: 'OTTER_TOKEN',
		clientIdEnv: 'OTTER_CLIENT_ID',
		clientSecretEnv: 'OTTER_CLIENT_SECRET',
	},
]

describe.each(CASES)('$config.displayName provider config', (c) => {
	it('signs in at the vendor with PKCE and asks for its published scopes', () => {
		expect(c.config.auth.type).toBe('oauth2')
		if (c.config.auth.type === 'oauth2') {
			expect(c.config.auth.config.authorizationUrl).toBe(c.authorizationUrl)
			expect(c.config.auth.config.tokenUrl).toBe(c.tokenUrl)
			expect(c.config.auth.config.pkce).toBe(true)
			expect(c.config.auth.config.scopes).toEqual(c.scopes)
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
		expect(classifyTool(c.config.name, 'delete_meeting')).toBe('write')
		expect(classifyTool(c.config.name, 'a_tool_added_later')).toBe('write')
		expect(classifyTool(c.config.name, 'a_tool_added_later', { readOnlyHint: true })).toBe('read')
		expect(
			classifyTool(c.config.name, 'get_transcript', { readOnlyHint: true, destructiveHint: true }),
		).toBe('write')
	})
})

describe('Fathom is a public client', () => {
	it('uses no token auth method and no revocation endpoint', () => {
		if (fathom.auth.type === 'oauth2') {
			expect(fathom.auth.config.tokenAuthMethod).toBe('none')
			expect(fathom.auth.config.revokeUrl).toBeUndefined()
		}
	})
})

describe('meeting-notes flag', () => {
	it('lists exactly the four providers', () => {
		expect([...MEETING_NOTES_PROVIDERS].sort()).toEqual(['fathom', 'fireflies', 'granola', 'otter'])
	})

	it('is off unless the actor is a tester', () => {
		const actor = '00000000-0000-4000-8000-000000000001'
		const off = parseFeatureFlagConfig({})
		const on = parseFeatureFlagConfig({
			FF_TESTER_ACTOR_IDS: actor,
			FF_TESTER_FEATURES: FLAGS.MEETING_NOTES_INTEGRATIONS,
		})
		expect(isFlagEnabled(actor, FLAGS.MEETING_NOTES_INTEGRATIONS, off)).toBe(false)
		expect(isFlagEnabled(actor, FLAGS.MEETING_NOTES_INTEGRATIONS, on)).toBe(true)
	})
})
