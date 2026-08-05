import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}))

// crypto = identity so encrypted claude_oauth blobs round-trip as their
// plaintext values — `resolveClaudeCredentialsWithFailover` reads the
// primary slot directly now, so tests drive it through the `db` mock's
// workspace row rather than mocking `getValidOAuthToken` (which it no
// longer calls).
vi.mock('../../lib/crypto', () => ({
	decrypt: (input: string) => input,
	encrypt: (input: string) => input,
}))

import {
	FallbackQuotaExceededError,
	LLM_ROUTE_AGENT,
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_OAUTH,
	LLM_ROUTE_SYSTEM_FALLBACK,
	getActorFallbackTokenUsage24h,
	readFallbackConfig,
	resolveLlmRoute,
} from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'

const ORIGINAL_ENV = { ...process.env }
const FALLBACK_ENV_KEYS = [
	'MASKIN_FALLBACK_OPENROUTER_KEY',
	'MASKIN_FALLBACK_BASE_URL',
	'MASKIN_FALLBACK_MODEL',
	'MASKIN_FALLBACK_SMALL_MODEL',
	'MASKIN_FALLBACK_DAILY_TOKEN_LIMIT',
] as const

beforeEach(() => {
	for (const k of FALLBACK_ENV_KEYS) delete process.env[k]
	process.env.MASKIN_CLAUDE_FAILOVER_ENABLED = undefined
})

afterEach(() => {
	process.env = { ...ORIGINAL_ENV }
})

function emptySettings(): WorkspaceSettings {
	return {
		display_names: { insight: 'Insight', bet: 'Bet', task: 'Task' },
		statuses: {},
		field_definitions: {},
		relationship_types: [],
		custom_extensions: {},
		enabled_modules: ['work'],
		max_concurrent_sessions: 3,
		llm_keys: {},
	} as WorkspaceSettings
}

/**
 * `where()` resolves directly to `rows` for `getActorFallbackTokenUsage24h`'s
 * unchained `select().from(sessions).where(...)` query, and ALSO exposes a
 * `.limit()` method for `resolveClaudeCredentialsWithFailover`'s
 * `select().from(workspaces).where(...).limit(1)` query — the same
 * thenable-plus-chainable idiom used by `__tests__/setup.ts`'s mock DB.
 * `workspaceRow` is omitted by default, so OAuth resolution sees "no
 * workspace" and returns null without touching claude_oauth data.
 */
function dbWithFallbackUsage(
	rows: Array<{ inputTokens: number; outputTokens: number }>,
	workspaceRow?: { id: string; settings: Record<string, unknown> },
) {
	const where = vi.fn(() => {
		const promise = Promise.resolve(rows) as Promise<unknown[]> & {
			limit: (n: number) => Promise<unknown[]>
		}
		promise.limit = vi.fn(async () => (workspaceRow ? [workspaceRow] : []))
		return promise
	})
	return {
		select: vi.fn().mockReturnValue({
			from: vi.fn().mockReturnValue({ where }),
		}),
	} as unknown as Database
}

function claudeOAuthWorkspaceRow(claudeOAuth: Record<string, unknown>): {
	id: string
	settings: Record<string, unknown>
} {
	return { id: 'ws-1', settings: { claude_oauth: claudeOAuth } }
}

describe('readFallbackConfig', () => {
	it('returns undefined apiKey when env not set', () => {
		const cfg = readFallbackConfig({})
		expect(cfg.apiKey).toBeUndefined()
		expect(cfg.dailyTokenLimit).toBe(550_000)
	})

	it('falls back to default model when small model not set', () => {
		const cfg = readFallbackConfig({
			MASKIN_FALLBACK_OPENROUTER_KEY: 'sk-or-x',
			MASKIN_FALLBACK_MODEL: 'foo/bar',
		})
		expect(cfg.smallModel).toBe('foo/bar')
	})

	it('uses default 550k limit on invalid input', () => {
		const cfg = readFallbackConfig({ MASKIN_FALLBACK_DAILY_TOKEN_LIMIT: 'not-a-number' })
		expect(cfg.dailyTokenLimit).toBe(550_000)
	})

	it('rejects negative limits and falls back to default', () => {
		const cfg = readFallbackConfig({ MASKIN_FALLBACK_DAILY_TOKEN_LIMIT: '-100' })
		expect(cfg.dailyTokenLimit).toBe(550_000)
	})
})

describe('getActorFallbackTokenUsage24h', () => {
	it('sums input + output tokens, treating null as 0', async () => {
		const db = dbWithFallbackUsage([
			{ inputTokens: 1000, outputTokens: 200 },
			{ inputTokens: 0, outputTokens: 50 },
			// biome-ignore lint/suspicious/noExplicitAny: simulating null DB columns
			{ inputTokens: null as any, outputTokens: 75 },
		])
		expect(await getActorFallbackTokenUsage24h(db, 'actor-1')).toBe(1325)
	})

	it('returns 0 when actor has no fallback sessions', async () => {
		const db = dbWithFallbackUsage([])
		expect(await getActorFallbackTokenUsage24h(db, 'actor-2')).toBe(0)
	})
})

describe('resolveLlmRoute priority order', () => {
	const baseParams = {
		db: dbWithFallbackUsage([]),
		workspaceId: 'ws-1',
		actorId: 'actor-1',
	}

	it('1. agent anthropic api_key wins over everything', async () => {
		const settings = emptySettings()
		settings.custom_llm = {
			enabled: true,
			base_url: 'https://example.com',
			api_key: 'sk-cust',
			model: 'mod',
		}
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: { provider: 'anthropic', apiKey: 'sk-agent' },
		})
		expect(result?.route).toBe(LLM_ROUTE_AGENT)
		expect(result?.envVars.ANTHROPIC_API_KEY).toBe('sk-agent')
		// Should not have fallen through to custom_llm:
		expect(result?.envVars.ANTHROPIC_BASE_URL).toBeUndefined()
	})

	it('1b. agent-level model preference is forwarded as ANTHROPIC_MODEL', async () => {
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: { provider: 'anthropic', apiKey: 'sk-agent', model: 'claude-sonnet-4-6' },
		})
		expect(result?.route).toBe(LLM_ROUTE_AGENT)
		expect(result?.envVars.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
	})

	it('omits ANTHROPIC_MODEL when agent has no model preference', async () => {
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: { provider: 'anthropic', apiKey: 'sk-agent' },
		})
		expect(result?.envVars.ANTHROPIC_MODEL).toBeUndefined()
	})

	it('returns null for non-anthropic agent override (caller handles)', async () => {
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: { provider: 'openai', apiKey: 'sk-openai' },
		})
		expect(result).toBeNull()
	})

	it('2. workspace custom_llm overrides Claude OAuth', async () => {
		const settings = emptySettings()
		settings.custom_llm = {
			enabled: true,
			base_url: 'https://openrouter.ai/api',
			api_key: 'sk-or-test',
			model: 'deepseek/deepseek-v4-flash',
		}
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_CUSTOM)
		expect(result?.envVars).toMatchObject({
			ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
			ANTHROPIC_AUTH_TOKEN: 'sk-or-test',
			ANTHROPIC_API_KEY: '',
			ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash',
			ANTHROPIC_SMALL_FAST_MODEL: 'deepseek/deepseek-v4-flash',
		})
		// OAuth env vars should NOT be set when custom_llm wins.
		expect(result?.envVars.CLAUDE_OAUTH_ACCESS_TOKEN).toBeUndefined()
	})

	it('2b. agent-level model preference is NOT forwarded on the custom_llm route (workspace-configured model wins)', async () => {
		const settings = emptySettings()
		settings.custom_llm = {
			enabled: true,
			base_url: 'https://openrouter.ai/api',
			api_key: 'sk-or-test',
			model: 'deepseek/deepseek-v4-flash',
		}
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: { model: 'claude-sonnet-4-6' },
		})
		expect(result?.route).toBe(LLM_ROUTE_CUSTOM)
		expect(result?.envVars.ANTHROPIC_MODEL).toBe('deepseek/deepseek-v4-flash')
	})

	it('skips custom_llm when enabled but missing fields', async () => {
		const settings = emptySettings()
		settings.custom_llm = { enabled: true, base_url: 'https://x', api_key: '', model: 'm' }
		settings.llm_keys = { anthropic: 'sk-ant-fallback' }
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_API_KEY)
		expect(result?.envVars.ANTHROPIC_API_KEY).toBe('sk-ant-fallback')
	})

	it('3. Claude OAuth wins over workspace api_key', async () => {
		const expiresAt = Date.now() + 60 * 60 * 1000
		const db = dbWithFallbackUsage(
			[],
			claudeOAuthWorkspaceRow({
				encryptedAccessToken: 'oauth-access',
				encryptedRefreshToken: 'oauth-refresh',
				expiresAt,
				scopes: ['read'],
				subscriptionType: 'pro',
			}),
		)
		const settings = emptySettings()
		settings.llm_keys = { anthropic: 'sk-ant-x' }
		const result = await resolveLlmRoute({
			db,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_OAUTH)
		expect(result?.envVars).toMatchObject({
			CLAUDE_OAUTH_ACCESS_TOKEN: 'oauth-access',
			CLAUDE_OAUTH_REFRESH_TOKEN: 'oauth-refresh',
			CLAUDE_OAUTH_EXPIRES_AT: String(expiresAt),
			CLAUDE_OAUTH_SCOPES: '["read"]',
			CLAUDE_OAUTH_SUBSCRIPTION_TYPE: 'pro',
		})
		expect(result?.envVars.ANTHROPIC_API_KEY).toBeUndefined()
	})

	it('3b. agent-level model preference is forwarded on the OAuth route', async () => {
		const expiresAt = Date.now() + 60 * 60 * 1000
		const db = dbWithFallbackUsage(
			[],
			claudeOAuthWorkspaceRow({
				encryptedAccessToken: 'oauth-access',
				encryptedRefreshToken: 'oauth-refresh',
				expiresAt,
				scopes: ['read'],
				subscriptionType: 'pro',
			}),
		)
		const result = await resolveLlmRoute({
			db,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			wsSettings: emptySettings(),
			agent: { model: 'claude-sonnet-4-6' },
		})
		expect(result?.route).toBe(LLM_ROUTE_OAUTH)
		expect(result?.envVars.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
	})

	it('4. workspace api_key when OAuth absent', async () => {
		const settings = emptySettings()
		settings.llm_keys = { anthropic: 'sk-ant-from-ws' }
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_API_KEY)
		expect(result?.envVars.ANTHROPIC_API_KEY).toBe('sk-ant-from-ws')
	})

	it('4b. agent-level model preference is forwarded on the workspace api_key route', async () => {
		const settings = emptySettings()
		settings.llm_keys = { anthropic: 'sk-ant-from-ws' }
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: { model: 'claude-opus-4-7' },
		})
		expect(result?.route).toBe(LLM_ROUTE_API_KEY)
		expect(result?.envVars.ANTHROPIC_MODEL).toBe('claude-opus-4-7')
	})

	it('falls through OAuth errors to next route', async () => {
		// Simulate a DB error during OAuth resolution's workspace read itself.
		const db = {
			select: vi.fn().mockReturnValue({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockReturnValue({
						limit: vi.fn().mockRejectedValue(new Error('db unavailable')),
					}),
				}),
			}),
		} as unknown as Database
		const settings = emptySettings()
		settings.llm_keys = { anthropic: 'sk-ant-recover' }
		const result = await resolveLlmRoute({
			db,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_API_KEY)
	})

	it('5. system fallback when nothing else set and env configured', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-system'
		process.env.MASKIN_FALLBACK_BASE_URL = 'https://openrouter.ai/api'
		process.env.MASKIN_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_SYSTEM_FALLBACK)
		expect(result?.envVars).toMatchObject({
			ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
			ANTHROPIC_AUTH_TOKEN: 'sk-or-system',
			ANTHROPIC_API_KEY: '',
			ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash',
		})
	})

	it('5b. agent-level model preference is NOT forwarded on the system fallback route (operator-configured model wins)', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-system'
		process.env.MASKIN_FALLBACK_BASE_URL = 'https://openrouter.ai/api'
		process.env.MASKIN_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: { model: 'claude-sonnet-4-6' },
		})
		expect(result?.route).toBe(LLM_ROUTE_SYSTEM_FALLBACK)
		expect(result?.envVars.ANTHROPIC_MODEL).toBe('deepseek/deepseek-v4-flash')
	})

	it('returns null when nothing is configured', async () => {
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: {},
		})
		expect(result).toBeNull()
	})

	it('throws FallbackQuotaExceededError when over the daily limit', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-system'
		process.env.MASKIN_FALLBACK_DAILY_TOKEN_LIMIT = '1000'
		const db = dbWithFallbackUsage([
			{ inputTokens: 800, outputTokens: 250 }, // 1050 > 1000
		])
		await expect(
			resolveLlmRoute({
				db,
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				wsSettings: emptySettings(),
				agent: {},
			}),
		).rejects.toBeInstanceOf(FallbackQuotaExceededError)
	})

	it('does NOT consume the fallback when usage is exactly at the limit', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-system'
		process.env.MASKIN_FALLBACK_DAILY_TOKEN_LIMIT = '1000'
		const db = dbWithFallbackUsage([{ inputTokens: 1000, outputTokens: 0 }])
		await expect(
			resolveLlmRoute({
				db,
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				wsSettings: emptySettings(),
				agent: {},
			}),
		).rejects.toBeInstanceOf(FallbackQuotaExceededError)
	})
})
