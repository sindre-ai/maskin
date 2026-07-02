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
	LLM_ROUTE_AGENT,
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
	LLM_ROUTE_OAUTH,
	PlanCapExceededError,
	checkPlanCap,
	getWorkspacePlanTokenUsage,
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

// Same shape as dbWithFallbackUsage — the workspace-plan query has the same
// drizzle call chain (select → from → where). Aliased for readability.
const dbWithSessionUsage = dbWithFallbackUsage

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
	})

	it('falls back to default model when small model not set', () => {
		const cfg = readFallbackConfig({
			MASKIN_FALLBACK_OPENROUTER_KEY: 'sk-or-x',
			MASKIN_FALLBACK_MODEL: 'foo/bar',
		})
		expect(cfg.smallModel).toBe('foo/bar')
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

	it('2. Claude OAuth overrides custom_llm', async () => {
		const db = dbWithFallbackUsage(
			[],
			claudeOAuthWorkspaceRow({
				encryptedAccessToken: 'oauth-access',
				encryptedRefreshToken: 'oauth-refresh',
				// Beyond the 10 min refresh buffer so the resolver doesn't try to
				// hit the real refresh endpoint from the unit test.
				expiresAt: Date.now() + 60 * 60 * 1000,
			}),
		)
		const settings = emptySettings()
		settings.custom_llm = {
			enabled: true,
			base_url: 'https://openrouter.ai/api',
			api_key: 'sk-or-test',
			model: 'deepseek/deepseek-v4-flash',
		}
		const result = await resolveLlmRoute({
			db,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			wsSettings: settings,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_OAUTH)
		expect(result?.envVars.CLAUDE_OAUTH_ACCESS_TOKEN).toBe('oauth-access')
		// custom_llm env vars should NOT be set when OAuth wins.
		expect(result?.envVars.ANTHROPIC_BASE_URL).toBeUndefined()
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

	it('returns null when nothing is configured', async () => {
		const result = await resolveLlmRoute({
			...baseParams,
			wsSettings: emptySettings(),
			agent: {},
		})
		expect(result).toBeNull()
	})

	describe('maskin_plan route', () => {
		beforeEach(() => {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
			process.env.MASKIN_FALLBACK_BASE_URL = 'https://openrouter.ai/api'
			process.env.MASKIN_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
		})

		it.each(['starter', 'pro', 'trial'] as const)(
			'%s plan routes through Maskin OR + Deepseek v4 Flash',
			async (plan) => {
				const settings = emptySettings()
				settings.billing = { plan }
				const result = await resolveLlmRoute({
					...baseParams,
					db: dbWithSessionUsage([]),
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

		it('maskin_plan is only used when no BYO credentials are present', async () => {
			const settings = emptySettings()
			settings.billing = { plan: 'pro' }
			const result = await resolveLlmRoute({
				...baseParams,
				db: dbWithSessionUsage([]),
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_MASKIN_PLAN)
			expect(result?.envVars.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-maskin')
		})

		it('OAuth wins over maskin_plan — never counts against cap', async () => {
			const db = dbWithSessionUsage(
				[],
				claudeOAuthWorkspaceRow({
					encryptedAccessToken: 'oauth-access',
					encryptedRefreshToken: 'r',
					expiresAt: Date.now() + 60 * 60 * 1000,
				}),
			)
			const settings = emptySettings()
			settings.billing = { plan: 'pro' }
			const result = await resolveLlmRoute({
				...baseParams,
				db,
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_OAUTH)
		})

		it('custom_llm wins over maskin_plan', async () => {
			const settings = emptySettings()
			settings.billing = { plan: 'pro' }
			settings.custom_llm = {
				enabled: true,
				base_url: 'https://example.com',
				api_key: 'sk-cust',
				model: 'mod',
			}
			const result = await resolveLlmRoute({
				...baseParams,
				db: dbWithSessionUsage([]),
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_CUSTOM)
		})

		it('workspace api_key wins over maskin_plan', async () => {
			const settings = emptySettings()
			settings.billing = { plan: 'pro' }
			settings.llm_keys = { anthropic: 'sk-ant-x' }
			const result = await resolveLlmRoute({
				...baseParams,
				db: dbWithSessionUsage([]),
				wsSettings: settings,
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_API_KEY)
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

		it('byollm plan does NOT route through maskin_plan', async () => {
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

		it('no billing block defaults to trial and routes through maskin_plan when no BYO set', async () => {
			const result = await resolveLlmRoute({
				...baseParams,
				db: dbWithSessionUsage([]),
				wsSettings: emptySettings(),
				agent: {},
			})
			expect(result?.route).toBe(LLM_ROUTE_MASKIN_PLAN)
		})
	})
})

describe('getWorkspacePlanTokenUsage', () => {
	it('sums input + output across maskin_plan sessions, treating null as 0', async () => {
		const db = dbWithSessionUsage([
			{ inputTokens: 5000, outputTokens: 1000 },
			// biome-ignore lint/suspicious/noExplicitAny: simulating null DB columns
			{ inputTokens: null as any, outputTokens: 250 },
			{ inputTokens: 750, outputTokens: 0 },
		])
		expect(await getWorkspacePlanTokenUsage(db, 'ws-1', 0)).toBe(7000)
	})

	it('returns 0 when the workspace has no maskin_plan sessions', async () => {
		const db = dbWithSessionUsage([])
		expect(await getWorkspacePlanTokenUsage(db, 'ws-2')).toBe(0)
	})
})

describe('checkPlanCap', () => {
	const ORIG_TRIAL_CAP = process.env.MASKIN_TRIAL_HARD_CAP_TOKENS

	afterEach(() => {
		if (ORIG_TRIAL_CAP === undefined) process.env.MASKIN_TRIAL_HARD_CAP_TOKENS = undefined
		else process.env.MASKIN_TRIAL_HARD_CAP_TOKENS = ORIG_TRIAL_CAP
	})

	it('treats missing billing as trial — enforces cap when over limit', async () => {
		const db = dbWithSessionUsage([{ inputTokens: 999_999, outputTokens: 0 }])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: emptySettings(),
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.plan).toBe('trial')
		expect(err.cap).toBe(100_000)
	})

	it('is a no-op for byollm — explicit opt-out', async () => {
		const settings = emptySettings()
		settings.billing = { plan: 'byollm', hard_cap_tokens: 100, period_start: 0 }
		const db = dbWithSessionUsage([{ inputTokens: 9999, outputTokens: 0 }])
		await expect(
			checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
		).resolves.toBeUndefined()
	})

	it.each(['starter', 'pro'] as const)(
		'is a no-op for %s when Stripe has not written hard_cap_tokens (fail-open pre-Task 5)',
		async (plan) => {
			const settings = emptySettings()
			settings.billing = { plan, period_start: Math.floor(Date.now() / 1000) - 60 }
			const db = dbWithSessionUsage([{ inputTokens: 50_000_000, outputTokens: 0 }])
			await expect(
				checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
			).resolves.toBeUndefined()
		},
	)

	it('throws PlanCapExceededError when usage equals hard_cap_tokens', async () => {
		// period_start is stored in Unix SECONDS (Stripe format).
		const periodStartSec = Math.floor(Date.now() / 1000) - 60
		const settings = emptySettings()
		settings.billing = {
			plan: 'starter',
			hard_cap_tokens: 1_000_000,
			period_start: periodStartSec,
		}
		const db = dbWithSessionUsage([
			{ inputTokens: 600_000, outputTokens: 400_000 }, // exactly at cap
		])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: settings,
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.plan).toBe('starter')
		expect(err.used).toBe(1_000_000)
		expect(err.cap).toBe(1_000_000)
		// period_end is in ms: period_start (seconds → ms) + 30 days.
		expect(err.periodEnd).toBe(periodStartSec * 1000 + 30 * 24 * 60 * 60 * 1000)
	})

	it('honors explicit period_end on the error payload', async () => {
		// period_start / period_end are Unix SECONDS; periodEnd on the error is MS.
		const settings = emptySettings()
		settings.billing = {
			plan: 'pro',
			hard_cap_tokens: 100,
			period_start: 1,
			period_end: 999_999,
		}
		const db = dbWithSessionUsage([{ inputTokens: 100, outputTokens: 0 }])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: settings,
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.periodEnd).toBe(999_999 * 1000)
	})

	it('uses MASKIN_TRIAL_HARD_CAP_TOKENS when trial has no explicit cap', async () => {
		process.env.MASKIN_TRIAL_HARD_CAP_TOKENS = '50000'
		const settings = emptySettings()
		settings.billing = { plan: 'trial' }
		const db = dbWithSessionUsage([{ inputTokens: 50_000, outputTokens: 0 }])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: settings,
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.plan).toBe('trial')
		expect(err.cap).toBe(50_000)
		// Trial with no period_start has periodEnd: null — frontend handles it.
		expect(err.periodEnd).toBeNull()
	})

	it('falls back to 100k trial default when env var is unset/invalid', async () => {
		process.env.MASKIN_TRIAL_HARD_CAP_TOKENS = undefined
		const settings = emptySettings()
		settings.billing = { plan: 'trial' }
		const db = dbWithSessionUsage([{ inputTokens: 100_000, outputTokens: 0 }])
		await expect(
			checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
		).rejects.toBeInstanceOf(PlanCapExceededError)
	})

	it('explicit billing.hard_cap_tokens overrides the trial default', async () => {
		process.env.MASKIN_TRIAL_HARD_CAP_TOKENS = '50000'
		const settings = emptySettings()
		settings.billing = { plan: 'trial', hard_cap_tokens: 200_000 }
		const db = dbWithSessionUsage([{ inputTokens: 60_000, outputTokens: 0 }])
		// Used (60k) is below explicit cap (200k) even though it exceeds env default (50k).
		await expect(
			checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
		).resolves.toBeUndefined()
	})

	it('resolveLlmRoute rejects with PlanCapExceededError when over the cap', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
		const settings = emptySettings()
		settings.billing = { plan: 'pro', hard_cap_tokens: 100, period_start: 0 }
		const db = dbWithSessionUsage([{ inputTokens: 200, outputTokens: 0 }])
		await expect(
			resolveLlmRoute({
				db,
				workspaceId: 'ws-1',
				wsSettings: settings,
				agent: {},
			}),
		).rejects.toBeInstanceOf(PlanCapExceededError)
	})
})
