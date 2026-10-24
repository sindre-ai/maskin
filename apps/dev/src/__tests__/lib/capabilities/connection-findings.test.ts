import { describe, expect, it } from 'vitest'
import {
	type IntegrationRow,
	findAvailableNotAttached,
	resolveToolAddedKind,
} from '../../../lib/capabilities/connection-findings'
import type { ProviderConfig } from '../../../lib/integrations/types'

const oauthConfig: ProviderConfig = {
	name: 'gmail',
	displayName: 'Gmail',
	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://example.com/auth',
			tokenUrl: 'https://example.com/token',
			scopes: ['mail.read', 'mail.send'],
			clientIdEnv: 'GMAIL_CLIENT_ID',
			clientSecretEnv: 'GMAIL_CLIENT_SECRET',
		},
	},
}

const apiKeyConfig: ProviderConfig = {
	name: 'notion',
	displayName: 'Notion',
	auth: { type: 'api_key', config: { headerName: 'Authorization' } },
	mcp: {
		envKey: 'NOTION_TOKEN',
		server: { type: 'http', url: 'https://mcp.example.com/notion' },
	},
}

const autoInjectConfig: ProviderConfig = {
	...apiKeyConfig,
	name: 'posthog',
	displayName: 'PostHog',
	mcp: {
		envKey: 'POSTHOG_TOKEN',
		autoInject: true,
		server: { type: 'http', url: 'https://mcp.example.com/posthog' },
	},
}

const noMcpConfig: ProviderConfig = {
	name: 'plain',
	displayName: 'Plain',
	auth: { type: 'api_key', config: { headerName: 'Authorization' } },
}

describe('resolveToolAddedKind', () => {
	it('records needs_reconnect when the stored token lacks a required scope', () => {
		expect(
			resolveToolAddedKind({
				config: oauthConfig,
				credentials: { scope: 'mail.read' },
				holders: ['agent-1'],
			}),
		).toEqual({ kind: 'needs_reconnect', missingScopes: ['mail.send'] })
	})

	it('names every missing scope, in the order the provider config declares them', () => {
		expect(
			resolveToolAddedKind({
				config: oauthConfig,
				credentials: { scope: '' },
				holders: ['agent-1'],
			}),
		).toEqual({ kind: 'needs_reconnect', missingScopes: ['mail.read', 'mail.send'] })
	})

	it('keeps tool_added when the token carries every required scope', () => {
		expect(
			resolveToolAddedKind({
				config: oauthConfig,
				credentials: { scope: 'mail.read mail.send' },
				holders: ['agent-1'],
			}),
		).toEqual({ kind: 'tool_added' })
	})

	it('keeps tool_added when the token records no scope string (unknown is not drift)', () => {
		expect(
			resolveToolAddedKind({ config: oauthConfig, credentials: {}, holders: ['agent-1'] }),
		).toEqual({ kind: 'tool_added' })
	})

	it('does not record needs_reconnect for a source nobody holds', () => {
		expect(
			resolveToolAddedKind({
				config: oauthConfig,
				credentials: { scope: 'mail.read' },
				holders: [],
			}),
		).toBeNull()
	})

	it('does not flag a tool_added on a source nobody holds', () => {
		expect(
			resolveToolAddedKind({
				config: oauthConfig,
				credentials: { scope: 'mail.read mail.send' },
				holders: [],
			}),
		).toBeNull()
	})

	it('keeps tool_added for a non-oauth2 provider (no scopes to compare)', () => {
		expect(
			resolveToolAddedKind({ config: apiKeyConfig, credentials: {}, holders: ['agent-1'] }),
		).toEqual({ kind: 'tool_added' })
	})

	it('keeps tool_added for a source with no provider config (built-in tools)', () => {
		expect(
			resolveToolAddedKind({ config: undefined, credentials: {}, holders: ['agent-1'] }),
		).toEqual({ kind: 'tool_added' })
	})

	it('carries scope names only', () => {
		const result = resolveToolAddedKind({
			config: oauthConfig,
			credentials: { scope: 'mail.read', accessToken: 'secret-token-value', refreshToken: 'r' },
			holders: ['agent-1'],
		})
		expect(Object.keys(result ?? {}).sort()).toEqual(['kind', 'missingScopes'])
		expect(JSON.stringify(result)).not.toContain('secret-token-value')
	})
})

describe('findAvailableNotAttached', () => {
	const configs: Record<string, ProviderConfig> = {
		notion: apiKeyConfig,
		posthog: autoInjectConfig,
		plain: noMcpConfig,
		gmail: oauthConfig,
	}
	const configFor = (provider: string) => configs[provider]
	const row = (provider: string, status = 'active'): IntegrationRow => ({
		sourceKey: `integration:${provider}:id-${provider}`,
		provider,
		integrationId: `id-${provider}`,
		status,
	})

	it('flags an active, opt-in MCP integration that no agent holds', () => {
		expect(
			findAvailableNotAttached({
				integrations: [row('notion')],
				configFor,
				holdersBySource: new Map([['integration:notion:id-notion', []]]),
			}),
		).toEqual([
			{
				kind: 'available_not_attached',
				sourceKey: 'integration:notion:id-notion',
				provider: 'notion',
				integrationId: 'id-notion',
			},
		])
	})

	it('treats a source missing from the holder map as having no holders', () => {
		expect(
			findAvailableNotAttached({
				integrations: [row('notion')],
				configFor,
				holdersBySource: new Map(),
			}),
		).toHaveLength(1)
	})

	it('does not flag an integration that has a holder', () => {
		expect(
			findAvailableNotAttached({
				integrations: [row('notion')],
				configFor,
				holdersBySource: new Map([['integration:notion:id-notion', ['agent-1']]]),
			}),
		).toEqual([])
	})

	it('never flags an autoInject provider, even with no holders', () => {
		expect(
			findAvailableNotAttached({
				integrations: [row('posthog')],
				configFor,
				holdersBySource: new Map([['integration:posthog:id-posthog', []]]),
			}),
		).toEqual([])
	})

	it('does not flag a provider that declares no mcp server', () => {
		expect(
			findAvailableNotAttached({
				integrations: [row('plain'), row('gmail')],
				configFor,
				holdersBySource: new Map(),
			}),
		).toEqual([])
	})

	it('does not flag an unknown provider', () => {
		expect(
			findAvailableNotAttached({
				integrations: [row('mystery')],
				configFor,
				holdersBySource: new Map(),
			}),
		).toEqual([])
	})

	it.each(['pending', 'revoked', 'error', 'awaiting_secret', 'inactive'])(
		'does not flag an integration whose status is %s',
		(status) => {
			expect(
				findAvailableNotAttached({
					integrations: [row('notion', status)],
					configFor,
					holdersBySource: new Map(),
				}),
			).toEqual([])
		},
	)

	it('carries the integration and nothing about any agent', () => {
		const [finding] = findAvailableNotAttached({
			integrations: [row('notion')],
			configFor,
			holdersBySource: new Map(),
		})
		expect(Object.keys(finding ?? {}).sort()).toEqual([
			'integrationId',
			'kind',
			'provider',
			'sourceKey',
		])
	})
})
