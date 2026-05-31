import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}))

const getValidOAuthTokenMock = vi.fn()
vi.mock('../../lib/claude-oauth', () => ({
	getValidOAuthToken: (...args: unknown[]) => getValidOAuthTokenMock(...args),
}))

import {
	FallbackQuotaExceededError,
	LLM_ROUTE_AGENT,
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
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
	getValidOAuthTokenMock.mockReset()
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

function dbWithFallbackUsage(rows: Array<{ inputTokens: number; outputTokens: number }>) {
	const where = vi.fn().mockResolvedValue(rows)
	return {
		select: vi.fn().mockReturnValue({
			from: vi.fn().mockReturnValue({ where }),
		}),
	} as unknown as Database
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

	it('returns null for non-anthropic agent override (caller handles)', async () => {
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: { provider: 'openai', apiKey: 'sk-openai' },
		})
		expect(result).toBeNull()
	})

	it('2. workspace custom_llm overrides Claude OAuth', async () => {
		getValidOAuthTokenMock.mockResolvedValue({
			tokens: {
				accessToken: 'oauth-access',
				refreshToken: 'oauth-refresh',
				expiresAt: Date.now() + 60_000,
			},
		})
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

	it('skips custom_llm when enabled but missing fields', async () => {
		getValidOAuthTokenMock.mockResolvedValue(null)
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
		getValidOAuthTokenMock.mockResolvedValue({
			tokens: {
				accessToken: 'oauth-access',
				refreshToken: 'oauth-refresh',
				expiresAt: 12345,
				scopes: ['read'],
				subscriptionType: 'pro',
			},
		})
		const settings = emptySettings()
		settings.llm_keys = { anthropic: 'sk-ant-x' }
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_OAUTH)
		expect(result?.envVars).toMatchObject({
			CLAUDE_OAUTH_ACCESS_TOKEN: 'oauth-access',
			CLAUDE_OAUTH_REFRESH_TOKEN: 'oauth-refresh',
			CLAUDE_OAUTH_EXPIRES_AT: '12345',
			CLAUDE_OAUTH_SCOPES: '["read"]',
			CLAUDE_OAUTH_SUBSCRIPTION_TYPE: 'pro',
		})
		expect(result?.envVars.ANTHROPIC_API_KEY).toBeUndefined()
	})

	it('4. workspace api_key when OAuth absent', async () => {
		getValidOAuthTokenMock.mockResolvedValue(null)
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

	it('falls through OAuth errors to next route', async () => {
		getValidOAuthTokenMock.mockRejectedValue(new Error('expired'))
		const settings = emptySettings()
		settings.llm_keys = { anthropic: 'sk-ant-recover' }
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_API_KEY)
	})

	it('5. system fallback when nothing else set and env configured', async () => {
		getValidOAuthTokenMock.mockResolvedValue(null)
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

	it('returns null when nothing is configured', async () => {
		getValidOAuthTokenMock.mockResolvedValue(null)
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: {},
		})
		expect(result).toBeNull()
	})

	it('throws FallbackQuotaExceededError when over the daily limit', async () => {
		getValidOAuthTokenMock.mockResolvedValue(null)
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

	describe('maskin_plan route', () => {
		beforeEach(() => {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
			process.env.MASKIN_FALLBACK_BASE_URL = 'https://openrouter.ai/api'
			process.env.MASKIN_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
		})

		it.each(['starter', 'pro'] as const)(
			'%s plan routes through Maskin OR + Deepseek v4 Flash',
			async (plan) => {
				getValidOAuthTokenMock.mockResolvedValue(null)
				const settings = emptySettings()
				settings.billing = { plan }
				const result = await resolveLlmRoute({
					...baseParams,
					wsSettings: settings,
					agent: {},
				})
				expect(result?.route).toBe(LLM_ROUTE_MASKIN_PLAN)
				expect(result?.envVars).toMatchObject({
					ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
					ANTHROPIC_AUTH_TOKEN: 'sk-or-maskin',
					ANTHROPIC_API_KEY: '',
					ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash',
					ANTHROPIC_SMALL_FAST_MODEL: 'deepseek/deepseek-v4-flash',
				})
			},
		)

		it('paid plan wins over custom_llm, OAuth, and workspace api_key', async () => {
			getValidOAuthTokenMock.mockResolvedValue({
				tokens: {
					accessToken: 'oauth-access',
					refreshToken: 'oauth-refresh',
					expiresAt: Date.now() + 60_000,
				},
			})
			const settings = emptySettings()
			settings.billing = { plan: 'pro' }
			settings.custom_llm = {
				enabled: true,
				base_url: 'https://example.com',
				api_key: 'sk-cust',
				model: 'mod',
			}
			settings.llm_keys = { anthropic: 'sk-ant-x' }
			const result = await resolveLlmRoute({
				...baseParams,
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_MASKIN_PLAN)
			expect(result?.envVars.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-maskin')
		})

		it('agent anthropic api_key still wins over paid plan', async () => {
			const settings = emptySettings()
			settings.billing = { plan: 'pro' }
			const result = await resolveLlmRoute({
				...baseParams,
				wsSettings: settings,
				agent: { provider: 'anthropic', apiKey: 'sk-agent' },
			})
			expect(result?.route).toBe(LLM_ROUTE_AGENT)
		})

		it.each(['trial', 'byollm'] as const)(
			'%s plan does NOT route through maskin_plan',
			async (plan) => {
				getValidOAuthTokenMock.mockResolvedValue(null)
				const settings = emptySettings()
				settings.billing = { plan }
				settings.llm_keys = { anthropic: 'sk-ant-from-ws' }
				const result = await resolveLlmRoute({
					...baseParams,
					wsSettings: settings,
					agent: {},
				})
				expect(result?.route).toBe(LLM_ROUTE_API_KEY)
				expect(result?.envVars.ANTHROPIC_API_KEY).toBe('sk-ant-from-ws')
			},
		)

		it('falls through when paid plan is set but operator OR key is missing', async () => {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = ''
			getValidOAuthTokenMock.mockResolvedValue(null)
			const settings = emptySettings()
			settings.billing = { plan: 'starter' }
			settings.llm_keys = { anthropic: 'sk-ant-recover' }
			const result = await resolveLlmRoute({
				...baseParams,
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_API_KEY)
		})

		it('workspace with no billing block behaves like before this change', async () => {
			getValidOAuthTokenMock.mockResolvedValue(null)
			const settings = emptySettings()
			settings.llm_keys = { anthropic: 'sk-ant-untouched' }
			const result = await resolveLlmRoute({
				...baseParams,
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_API_KEY)
		})
	})

	it('does NOT consume the fallback when usage is exactly at the limit', async () => {
		getValidOAuthTokenMock.mockResolvedValue(null)
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
