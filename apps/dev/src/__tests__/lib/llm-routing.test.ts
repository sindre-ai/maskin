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
	PlanCapExceededError,
	assertWithinMaskinPlanCap,
	getActorFallbackTokenUsage24h,
	getWorkspaceMaskinPlanTokenUsage,
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
	'MASKIN_TRIAL_HARD_CAP_TOKENS',
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

		it.each(['trial', 'starter', 'pro'] as const)(
			'%s plan routes through Maskin OR + Deepseek v4 Flash',
			async (plan) => {
				getValidOAuthTokenMock.mockResolvedValue(null)
				const settings = emptySettings()
				settings.billing = { plan, hard_cap_tokens: 1_000_000 }
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
			settings.billing = { plan: 'pro', hard_cap_tokens: 1_000_000 }
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
			settings.billing = { plan: 'pro', hard_cap_tokens: 1_000_000 }
			const result = await resolveLlmRoute({
				...baseParams,
				wsSettings: settings,
				agent: { provider: 'anthropic', apiKey: 'sk-agent' },
			})
			expect(result?.route).toBe(LLM_ROUTE_AGENT)
		})

		it('byollm plan does NOT route through maskin_plan', async () => {
			getValidOAuthTokenMock.mockResolvedValue(null)
			const settings = emptySettings()
			settings.billing = { plan: 'byollm' }
			settings.llm_keys = { anthropic: 'sk-ant-from-ws' }
			const result = await resolveLlmRoute({
				...baseParams,
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_API_KEY)
			expect(result?.envVars.ANTHROPIC_API_KEY).toBe('sk-ant-from-ws')
		})

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

describe('getWorkspaceMaskinPlanTokenUsage', () => {
	it('sums input + output tokens for the workspace', async () => {
		const db = dbWithFallbackUsage([
			{ inputTokens: 5000, outputTokens: 1000 },
			{ inputTokens: 200, outputTokens: 50 },
		])
		expect(await getWorkspaceMaskinPlanTokenUsage(db, 'ws-1', 0)).toBe(6250)
	})

	it('treats null token columns as 0 instead of NaN', async () => {
		const db = dbWithFallbackUsage([
			// biome-ignore lint/suspicious/noExplicitAny: simulating null DB columns
			{ inputTokens: null as any, outputTokens: 100 },
			// biome-ignore lint/suspicious/noExplicitAny: simulating null DB columns
			{ inputTokens: 200, outputTokens: null as any },
		])
		expect(await getWorkspaceMaskinPlanTokenUsage(db, 'ws-1', 0)).toBe(300)
	})

	it('returns 0 when workspace has no maskin_plan sessions in period', async () => {
		const db = dbWithFallbackUsage([])
		expect(await getWorkspaceMaskinPlanTokenUsage(db, 'ws-2', 1_700_000_000)).toBe(0)
	})
})

describe('PlanCapExceededError', () => {
	it('carries the typed code, 402 status, and payload fields', () => {
		const err = new PlanCapExceededError('starter', 1_200_000, 1_000_000, 1_733_592_000)
		expect(err.code).toBe('PLAN_CAP_EXCEEDED')
		expect(err.httpStatus).toBe(402)
		expect(err.plan).toBe('starter')
		expect(err.used).toBe(1_200_000)
		expect(err.cap).toBe(1_000_000)
		expect(err.periodEndSeconds).toBe(1_733_592_000)
		expect(err.message).toContain('starter')
		expect(err.message).toContain('1,200,000')
		expect(err.message).toContain('1,000,000')
	})

	it('accepts null periodEndSeconds for trial (no scheduled reset)', () => {
		const err = new PlanCapExceededError('trial', 100_000, 100_000, null)
		expect(err.plan).toBe('trial')
		expect(err.periodEndSeconds).toBeNull()
	})
})

describe('assertWithinMaskinPlanCap', () => {
	it('is a no-op when the workspace has no billing block', async () => {
		const db = dbWithFallbackUsage([])
		await expect(assertWithinMaskinPlanCap(db, 'ws-1', undefined)).resolves.toBeUndefined()
	})

	it('is a no-op for byollm (no Maskin-hosted plan)', async () => {
		const db = dbWithFallbackUsage([])
		await expect(assertWithinMaskinPlanCap(db, 'ws-1', { plan: 'byollm' })).resolves.toBeUndefined()
	})

	it('throws PlanCapExceededError when starter usage is at the cap', async () => {
		const db = dbWithFallbackUsage([
			// 600k + 400k = 1M, exactly at cap → rejects (boundary is inclusive).
			{ inputTokens: 600_000, outputTokens: 400_000 },
		])
		const billing = {
			plan: 'starter' as const,
			period_start: 1_700_000_000,
			hard_cap_tokens: 1_000_000,
		}
		await expect(assertWithinMaskinPlanCap(db, 'ws-1', billing)).rejects.toMatchObject({
			name: 'PlanCapExceededError',
			plan: 'starter',
			used: 1_000_000,
			cap: 1_000_000,
			periodEndSeconds: 1_700_000_000 + 30 * 24 * 60 * 60,
		})
	})

	it('throws PlanCapExceededError when pro usage exceeds the cap', async () => {
		const db = dbWithFallbackUsage([{ inputTokens: 1_500_000, outputTokens: 600_000 }])
		const billing = {
			plan: 'pro' as const,
			period_start: 1_700_000_000,
			hard_cap_tokens: 2_000_000,
		}
		await expect(assertWithinMaskinPlanCap(db, 'ws-1', billing)).rejects.toMatchObject({
			plan: 'pro',
			used: 2_100_000,
			cap: 2_000_000,
		})
	})

	it('passes when usage is below the cap', async () => {
		const db = dbWithFallbackUsage([{ inputTokens: 100_000, outputTokens: 50_000 }])
		const billing = {
			plan: 'starter' as const,
			period_start: 1_700_000_000,
			hard_cap_tokens: 1_000_000,
		}
		await expect(assertWithinMaskinPlanCap(db, 'ws-1', billing)).resolves.toBeUndefined()
	})

	it('uses the default trial cap when hard_cap_tokens is unset', async () => {
		// 100,001 tokens used; default trial cap is 100,000 → rejects.
		const db = dbWithFallbackUsage([{ inputTokens: 60_000, outputTokens: 40_001 }])
		const billing = { plan: 'trial' as const }
		await expect(assertWithinMaskinPlanCap(db, 'ws-1', billing)).rejects.toMatchObject({
			plan: 'trial',
			cap: 100_000,
			periodEndSeconds: null,
		})
	})

	it('honors MASKIN_TRIAL_HARD_CAP_TOKENS env override', async () => {
		const db = dbWithFallbackUsage([{ inputTokens: 6_000, outputTokens: 0 }])
		const billing = { plan: 'trial' as const }
		// Override the default 100k trial cap down to 5k.
		await expect(
			assertWithinMaskinPlanCap(db, 'ws-1', billing, {
				MASKIN_TRIAL_HARD_CAP_TOKENS: '5000',
			} as NodeJS.ProcessEnv),
		).rejects.toMatchObject({ plan: 'trial', cap: 5000, used: 6000 })
	})

	it('fails closed for starter/pro when hard_cap_tokens missing (cap = 0)', async () => {
		const db = dbWithFallbackUsage([])
		// hard_cap_tokens unset means the Stripe webhook hasn't populated it; we
		// 402 immediately rather than underwriting unbounded usage.
		await expect(
			assertWithinMaskinPlanCap(db, 'ws-1', { plan: 'starter', period_start: 1_700_000_000 }),
		).rejects.toMatchObject({ plan: 'starter', cap: 0 })
	})
})

describe('resolveLlmRoute cap enforcement', () => {
	beforeEach(() => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
		process.env.MASKIN_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
	})

	it('refuses maskin_plan route when starter workspace is over cap', async () => {
		const db = dbWithFallbackUsage([{ inputTokens: 1_500_000, outputTokens: 0 }])
		const settings = emptySettings()
		settings.billing = {
			plan: 'starter',
			period_start: 1_700_000_000,
			hard_cap_tokens: 1_000_000,
		}
		await expect(
			resolveLlmRoute({
				db,
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				wsSettings: settings,
				agent: {},
			}),
		).rejects.toBeInstanceOf(PlanCapExceededError)
	})

	it('allows maskin_plan route when starter workspace is under cap', async () => {
		const db = dbWithFallbackUsage([{ inputTokens: 100_000, outputTokens: 0 }])
		const settings = emptySettings()
		settings.billing = {
			plan: 'starter',
			period_start: 1_700_000_000,
			hard_cap_tokens: 1_000_000,
		}
		const result = await resolveLlmRoute({
			db,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_MASKIN_PLAN)
	})

	it('refuses maskin_plan route when trial workspace exceeds default trial cap', async () => {
		const db = dbWithFallbackUsage([{ inputTokens: 100_000, outputTokens: 100 }])
		const settings = emptySettings()
		settings.billing = { plan: 'trial' }
		await expect(
			resolveLlmRoute({
				db,
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				wsSettings: settings,
				agent: {},
			}),
		).rejects.toMatchObject({ name: 'PlanCapExceededError', plan: 'trial' })
	})
})
