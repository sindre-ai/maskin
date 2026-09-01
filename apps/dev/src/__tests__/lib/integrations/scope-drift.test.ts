import { describe, expect, it } from 'vitest'
import {
	integrationScopeGaps,
	missingScopes,
	parseScopes,
} from '../../../lib/integrations/scope-drift'
import type { ProviderConfig } from '../../../lib/integrations/types'

describe('parseScopes', () => {
	// Slack returns comma-separated scopes; most other providers use spaces.
	// Splitting on both is what makes one helper serve every provider.
	it('splits comma-separated scopes', () => {
		expect(parseScopes('chat:write,channels:read')).toEqual(
			new Set(['chat:write', 'channels:read']),
		)
	})

	it('splits space-separated scopes', () => {
		expect(parseScopes('chat:write channels:read')).toEqual(
			new Set(['chat:write', 'channels:read']),
		)
	})

	it('tolerates mixed separators and stray whitespace', () => {
		expect(parseScopes(' chat:write, channels:read   groups:read ')).toEqual(
			new Set(['chat:write', 'channels:read', 'groups:read']),
		)
	})

	it('returns an empty set for undefined, null and empty input', () => {
		expect(parseScopes(undefined).size).toBe(0)
		expect(parseScopes(null).size).toBe(0)
		expect(parseScopes('').size).toBe(0)
	})
})

describe('missingScopes', () => {
	it('returns the required scopes the token does not carry', () => {
		expect(missingScopes('chat:write,channels:read', ['chat:write', 'channels:history'])).toEqual([
			'channels:history',
		])
	})

	it('returns an empty array when every required scope is present', () => {
		expect(missingScopes('chat:write channels:read', ['chat:write'])).toEqual([])
	})

	it('treats a token with no scope string as missing everything', () => {
		expect(missingScopes(undefined, ['chat:write', 'channels:read'])).toEqual([
			'chat:write',
			'channels:read',
		])
	})

	it('ignores extra scopes the token holds beyond what is required', () => {
		expect(missingScopes('a,b,c', ['a'])).toEqual([])
	})

	it('preserves the order declared in the provider config', () => {
		expect(missingScopes('', ['z:read', 'a:read', 'm:read'])).toEqual([
			'z:read',
			'a:read',
			'm:read',
		])
	})
})

function oauthConfig(scopes: string[], userScope?: string): ProviderConfig {
	return {
		name: 'test',
		displayName: 'Test',
		auth: {
			type: 'oauth2',
			config: {
				authorizationUrl: 'https://example.com/authorize',
				tokenUrl: 'https://example.com/token',
				scopes,
				clientIdEnv: 'TEST_CLIENT_ID',
				clientSecretEnv: 'TEST_CLIENT_SECRET',
				...(userScope ? { extraAuthParams: { user_scope: userScope } } : {}),
			},
		},
	}
}

describe('integrationScopeGaps', () => {
	it('reports no drift when the stored scope covers the config', () => {
		const result = integrationScopeGaps(oauthConfig(['chat:write', 'channels:read']), {
			scope: 'chat:write,channels:read',
		})
		expect(result).toEqual({ missing: [], needsReconnect: false })
	})

	// The case that forced this helper: an install predating the history scopes.
	it('reports bot scopes added to the config after the install', () => {
		const result = integrationScopeGaps(
			oauthConfig(['chat:write', 'channels:read', 'channels:history', 'groups:history']),
			{ scope: 'chat:write,channels:read' },
		)
		expect(result.missing).toEqual(['channels:history', 'groups:history'])
		expect(result.needsReconnect).toBe(true)
	})

	// Bot and user scopes are granted as two independent lists in one exchange
	// and stored under different keys, so a token can satisfy one and not the other.
	it('reports a missing user scope even when every bot scope is present', () => {
		const result = integrationScopeGaps(oauthConfig(['chat:write'], 'search:read'), {
			scope: 'chat:write',
		})
		expect(result.missing).toEqual(['search:read'])
		expect(result.needsReconnect).toBe(true)
	})

	it('reports no drift when both the bot and user scopes are satisfied', () => {
		const result = integrationScopeGaps(oauthConfig(['chat:write'], 'search:read'), {
			scope: 'chat:write',
			userScope: 'search:read',
		})
		expect(result).toEqual({ missing: [], needsReconnect: false })
	})

	it('does not confuse a user scope granted as a bot scope', () => {
		// `search:read` in the BOT scope string must not satisfy the user-scope
		// requirement — Slack would never grant it there.
		const result = integrationScopeGaps(oauthConfig(['chat:write'], 'search:read'), {
			scope: 'chat:write,search:read',
		})
		expect(result.missing).toEqual(['search:read'])
	})

	it('reports both bot and user gaps together', () => {
		const result = integrationScopeGaps(
			oauthConfig(['chat:write', 'channels:history'], 'search:read'),
			{
				scope: 'chat:write',
			},
		)
		expect(result.missing).toEqual(['channels:history', 'search:read'])
	})

	// api_key providers have no scopes, and oauth2_custom (GitHub Apps) derives
	// permissions from the installation rather than a scope string — comparing
	// either would produce false "reconnect" prompts.
	it('skips providers that are not standard oauth2', () => {
		const apiKeyProvider: ProviderConfig = {
			name: 'test',
			displayName: 'Test',
			auth: { type: 'api_key', config: { headerName: 'X-Api-Key', envKeyName: 'TEST_KEY' } },
		}
		expect(integrationScopeGaps(apiKeyProvider, { scope: undefined })).toEqual({
			missing: [],
			needsReconnect: false,
		})
	})

	it('treats a non-string stored scope as absent rather than throwing', () => {
		const result = integrationScopeGaps(oauthConfig(['chat:write']), { scope: 12345 })
		expect(result.missing).toEqual(['chat:write'])
	})
})
