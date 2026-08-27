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
	PRO_HARD_CAP_DEFAULT_USD_CENTS,
	TEAM_HARD_CAP_DEFAULT_USD_CENTS,
} from '../../lib/billing-defaults'
import { preflightLlmCredentials } from '../../lib/llm-routing'
import {
	LLM_ROUTE_AGENT,
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
	LLM_ROUTE_OAUTH,
	LlmCredentialsUnavailableError,
	PlanCapExceededError,
	ceilCents,
	checkPlanCap,
	getWorkspacePlanUsdCentsUsage,
	readFallbackConfig,
	resolveChatCredentials,
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
	rows: Array<{ inputTokens: number; outputTokens: number; totalCostUsd?: string | null }>,
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
		byollmAllowed: true,
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
			byollmAllowed: true,
			agent: {},
		})
		expect(result?.route).toBe(LLM_ROUTE_OAUTH)
		expect(result?.envVars.CLAUDE_OAUTH_ACCESS_TOKEN).toBe('oauth-access')
		// custom_llm env vars should NOT be set when OAuth wins.
		expect(result?.envVars.ANTHROPIC_BASE_URL).toBeUndefined()
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
			byollmAllowed: true,
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
			byollmAllowed: true,
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
			byollmAllowed: true,
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

		it.each(['pro', 'team', 'trial'] as const)(
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
			settings.billing = { plan: 'pro' }
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

describe('getWorkspacePlanUsdCentsUsage', () => {
	it("sums each session's reported dollar cost, falling back to a flat token rate when unreported", async () => {
		const db = dbWithSessionUsage([
			{ totalCostUsd: '1.00', inputTokens: 0, outputTokens: 0 },
			{ totalCostUsd: '0.50', inputTokens: 0, outputTokens: 0 },
			// No reported cost — falls back to 16,000 tokens/cent: 16,000 -> 1 cent.
			{ totalCostUsd: null, inputTokens: 16_000, outputTokens: 0 },
		])
		expect(await getWorkspacePlanUsdCentsUsage(db, 'ws-1', 0)).toBe(151)
	})

	it('returns 0 when the workspace has no maskin_plan sessions', async () => {
		const db = dbWithSessionUsage([])
		expect(await getWorkspacePlanUsdCentsUsage(db, 'ws-2')).toBe(0)
	})
})

describe('checkPlanCap', () => {
	const ORIG_TRIAL_CAP = process.env.MASKIN_TRIAL_HARD_CAP_USD_CENTS

	afterEach(() => {
		if (ORIG_TRIAL_CAP === undefined) process.env.MASKIN_TRIAL_HARD_CAP_USD_CENTS = undefined
		else process.env.MASKIN_TRIAL_HARD_CAP_USD_CENTS = ORIG_TRIAL_CAP
	})

	it('treats missing billing as trial — enforces cap when over limit', async () => {
		// Trial default is $10.00 (1,000 cents); $10.01 of reported cost is over.
		const db = dbWithSessionUsage([{ totalCostUsd: '10.01', inputTokens: 0, outputTokens: 0 }])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: emptySettings(),
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.plan).toBe('trial')
		expect(err.cap).toBe(1_000)
	})

	it('is a no-op for byollm — explicit opt-out', async () => {
		const settings = emptySettings()
		settings.billing = { plan: 'byollm', hard_cap_usd_cents: 100, period_start: 0 }
		const db = dbWithSessionUsage([{ totalCostUsd: '99.00', inputTokens: 0, outputTokens: 0 }])
		await expect(
			checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
		).resolves.toBeUndefined()
	})

	// Regression: this pair used to assert the opposite — that a paid plan with
	// no `hard_cap_usd_cents` yet was uncapped. That window is real (delayed or
	// failed Stripe webhook) and it let a pro/team workspace spend without
	// bound on Maskin's OpenRouter account. The cap now falls back to the
	// plan's published default instead of to infinity.
	it.each([
		['pro', PRO_HARD_CAP_DEFAULT_USD_CENTS],
		['team', TEAM_HARD_CAP_DEFAULT_USD_CENTS],
	] as const)(
		'falls back to the %s default cap when Stripe has not written hard_cap_usd_cents',
		async (plan, capCents) => {
			const settings = emptySettings()
			settings.billing = { plan, period_start: Math.floor(Date.now() / 1000) - 60 }
			// One cent over the plan's default cap.
			const overCapUsd = ((capCents + 1) / 100).toFixed(2)
			const db = dbWithSessionUsage([{ totalCostUsd: overCapUsd, inputTokens: 0, outputTokens: 0 }])
			await expect(
				checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
			).rejects.toBeInstanceOf(PlanCapExceededError)
		},
	)

	it.each([
		['pro', PRO_HARD_CAP_DEFAULT_USD_CENTS],
		['team', TEAM_HARD_CAP_DEFAULT_USD_CENTS],
	] as const)(
		'stays under the %s default cap when usage has not reached it',
		async (plan, capCents) => {
			const settings = emptySettings()
			settings.billing = { plan, period_start: Math.floor(Date.now() / 1000) - 60 }
			const underCapUsd = ((capCents - 1) / 100).toFixed(2)
			const db = dbWithSessionUsage([
				{ totalCostUsd: underCapUsd, inputTokens: 0, outputTokens: 0 },
			])
			await expect(
				checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
			).resolves.toBeUndefined()
		},
	)

	it('throws PlanCapExceededError when usage equals hard_cap_usd_cents', async () => {
		// period_start is stored in Unix SECONDS (Stripe format).
		const periodStartSec = Math.floor(Date.now() / 1000) - 60
		const settings = emptySettings()
		settings.billing = {
			plan: 'pro',
			hard_cap_usd_cents: 1_000,
			period_start: periodStartSec,
		}
		const db = dbWithSessionUsage([
			{ totalCostUsd: '10.00', inputTokens: 0, outputTokens: 0 }, // exactly at cap ($10.00 = 1000¢)
		])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: settings,
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.plan).toBe('pro')
		expect(err.used).toBe(1_000)
		expect(err.cap).toBe(1_000)
		// period_end is in ms: period_start (seconds → ms) + 30 days.
		expect(err.periodEnd).toBe(periodStartSec * 1000 + 30 * 24 * 60 * 60 * 1000)
	})

	it('honors explicit period_end on the error payload', async () => {
		// period_start / period_end are Unix SECONDS; periodEnd on the error is MS.
		const settings = emptySettings()
		settings.billing = {
			plan: 'pro',
			hard_cap_usd_cents: 1,
			period_start: 1,
			period_end: 999_999,
		}
		const db = dbWithSessionUsage([{ totalCostUsd: '0.01', inputTokens: 0, outputTokens: 0 }])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: settings,
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.periodEnd).toBe(999_999 * 1000)
	})

	it('uses MASKIN_TRIAL_HARD_CAP_USD_CENTS when trial has no explicit cap', async () => {
		process.env.MASKIN_TRIAL_HARD_CAP_USD_CENTS = '50'
		const settings = emptySettings()
		settings.billing = { plan: 'trial' }
		const db = dbWithSessionUsage([{ totalCostUsd: '0.50', inputTokens: 0, outputTokens: 0 }])
		const err = await checkPlanCap({
			db,
			workspaceId: 'ws-1',
			wsSettings: settings,
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.plan).toBe('trial')
		expect(err.cap).toBe(50)
		// Trial with no period_start has periodEnd: null — frontend handles it.
		expect(err.periodEnd).toBeNull()
	})

	it('falls back to the $10.00 trial default when env var is unset/invalid', async () => {
		process.env.MASKIN_TRIAL_HARD_CAP_USD_CENTS = undefined
		const settings = emptySettings()
		settings.billing = { plan: 'trial' }
		const db = dbWithSessionUsage([{ totalCostUsd: '10.00', inputTokens: 0, outputTokens: 0 }])
		await expect(
			checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
		).rejects.toBeInstanceOf(PlanCapExceededError)
	})

	it('explicit billing.hard_cap_usd_cents overrides the trial default', async () => {
		process.env.MASKIN_TRIAL_HARD_CAP_USD_CENTS = '50'
		const settings = emptySettings()
		settings.billing = { plan: 'trial', hard_cap_usd_cents: 200 }
		const db = dbWithSessionUsage([{ totalCostUsd: '0.60', inputTokens: 0, outputTokens: 0 }])
		// Used (60¢) is below explicit cap (200¢) even though it exceeds env default (50¢).
		await expect(
			checkPlanCap({ db, workspaceId: 'ws-1', wsSettings: settings }),
		).resolves.toBeUndefined()
	})

	it('resolveLlmRoute rejects with PlanCapExceededError when over the cap', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
		const settings = emptySettings()
		settings.billing = { plan: 'pro', hard_cap_usd_cents: 100, period_start: 0 }
		const db = dbWithSessionUsage([{ totalCostUsd: '2.00', inputTokens: 0, outputTokens: 0 }])
		await expect(
			resolveLlmRoute({
				db,
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				wsSettings: settings,
				byollmAllowed: false,
				agent: {},
			}),
		).rejects.toBeInstanceOf(PlanCapExceededError)
	})
})

describe('ceilCents', () => {
	// The reason this helper exists rather than a bare Math.ceil: floating-point
	// dollar→cent conversion lands a hair ABOVE an exact integer for a subset of
	// ordinary prices, and Math.ceil then bills a whole cent that was never
	// spent. $10.05 over a $10.00 cap is 5 cents of overage, not 6.
	it('does not round up a value that is only above an integer by IEEE754 dust', () => {
		expect(10.05 * 100).toBeGreaterThan(1005) // the dust this guards against
		expect(ceilCents(10.05 * 100)).toBe(1005)
	})

	it('leaves values that already land exactly alone', () => {
		expect(ceilCents(10.01 * 100)).toBe(1001)
		expect(ceilCents(10.3 * 100)).toBe(1030)
		expect(ceilCents(0)).toBe(0)
	})

	it('still rounds genuine sub-cent usage up to a whole cent', () => {
		// The token-rate fallback is the only producer of fractional cents; its
		// smallest non-zero output (1 / FALLBACK_TOKENS_PER_USD_CENT = 6.25e-5)
		// must not be snapped away to zero.
		expect(ceilCents(1 / 16_000)).toBe(1)
		expect(ceilCents(1004.5)).toBe(1005)
	})
})

// The OAuth resolver reports an unusable credential two ways: it throws, or it
// returns null. Both must reach the caller as LlmCredentialsUnavailableError
// when nothing else is configured — a session that launches with no
// ANTHROPIC_* env is the failure this whole path exists to prevent.
describe('resolveLlmRoute when the Claude OAuth route yields nothing', () => {
	const deadSlot = {
		encryptedAccessToken: 'oauth-access',
		encryptedRefreshToken: 'oauth-refresh',
		// Already expired, so the resolver must refresh — and the refresh below
		// fails, leaving it with no usable token.
		expiresAt: Date.now() - 60_000,
	}

	beforeEach(() => {
		// A refresh that never succeeds: the resolver classifies this as a
		// transport error, keeps the (expired) token, and returns null rather
		// than throwing. That null is the branch under test.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network unreachable')
			}),
		)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function paramsWithDeadOAuth(settings: WorkspaceSettings) {
		settings.claude_oauth = deadSlot
		return {
			db: dbWithFallbackUsage([], claudeOAuthWorkspaceRow(deadSlot)),
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			wsSettings: settings,
			byollmAllowed: true,
			agent: {},
			env: {} as NodeJS.ProcessEnv,
		}
	}

	it('throws LlmCredentialsUnavailableError when no other route is configured', async () => {
		await expect(resolveLlmRoute(paramsWithDeadOAuth(emptySettings()))).rejects.toBeInstanceOf(
			LlmCredentialsUnavailableError,
		)
	})

	it('carries the reason through to the persisted failure_reason', async () => {
		const err = await resolveLlmRoute(paramsWithDeadOAuth(emptySettings())).catch((e) => e)
		expect(err).toBeInstanceOf(LlmCredentialsUnavailableError)
		const reason = (err as LlmCredentialsUnavailableError).toFailureReason()
		expect(reason.reason_code).toBe('not_logged_in')
		// The resolver reports WHY, so the detail names the specific failure
		// rather than the old catch-all "did not yield a usable token".
		expect(reason.verbatim_output).toMatch(/could not be reached/i)
	})

	it('marks an unreachable token endpoint transient, and says so to the user', async () => {
		// This fixture's refresh fails with a network error, not a rejection —
		// we never learned the subscription is bad. Reporting it as permanent
		// would tell the user to reconnect a credential that may be fine and
		// would deny the dispatcher the retry that recovers it.
		const err = (await resolveLlmRoute(paramsWithDeadOAuth(emptySettings())).catch(
			(e) => e,
		)) as LlmCredentialsUnavailableError
		expect(err.transient).toBe(true)
		expect(err.toFailureReason().human_message).toMatch(/usually temporary/i)
		expect(err.toFailureReason().human_message).not.toMatch(/Connect a Claude subscription/i)
	})

	it('does NOT throw when custom_llm still resolves', async () => {
		// The fall-through the comment in resolveLlmRoute promises: a dead
		// subscription behind a working custom endpoint is recoverable, and
		// turning it into a hard failure would break every such workspace.
		const settings = emptySettings()
		settings.custom_llm = {
			enabled: true,
			base_url: 'https://example.com',
			api_key: 'sk-cust',
			model: 'mod',
		}
		const result = await resolveLlmRoute(paramsWithDeadOAuth(settings))
		expect(result?.route).toBe(LLM_ROUTE_CUSTOM)
	})

	it('does NOT throw when the workspace anthropic key still resolves', async () => {
		const settings = emptySettings()
		settings.llm_keys = { anthropic: 'sk-ant-ws' }
		const result = await resolveLlmRoute(paramsWithDeadOAuth(settings))
		expect(result?.route).toBe(LLM_ROUTE_API_KEY)
	})

	it('returns null (no throw) when the workspace has no OAuth configured at all', async () => {
		// A null from a workspace with nothing connected is "route not
		// configured", not a failure — it must keep falling through to the
		// caller's own non-anthropic handling.
		const result = await resolveLlmRoute({
			db: dbWithFallbackUsage([]),
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			wsSettings: emptySettings(),
			byollmAllowed: true,
			agent: {},
			env: {} as NodeJS.ProcessEnv,
		})
		expect(result).toBeNull()
	})
})

// The offline gate that runs before a session is marked `starting`. It answers
// "is any route configured at all", never "is the credential live" — liveness
// stays with the (now timeout-bounded) probe inside resolveLlmRoute. Its
// priority order must track resolveLlmRoute's, so each route gets a case.
describe('preflightLlmCredentials', () => {
	const noEnv: NodeJS.ProcessEnv = {}
	/** Failover on — `active_slot` is what the resolver will read. */
	const failoverEnv: NodeJS.ProcessEnv = { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' }

	const slotData = () => ({
		encryptedAccessToken: 'a',
		encryptedRefreshToken: 'r',
		expiresAt: Date.now() + 3_600_000,
	})

	it('passes when the agent carries its own key', () => {
		expect(
			preflightLlmCredentials({
				wsSettings: {},
				agent: { provider: 'anthropic', apiKey: 'sk-ant-agent' },
				byollmAllowed: true,
				env: noEnv,
			}),
		).toBeNull()
	})

	it('fails a non-anthropic agent key when the workspace is not entitled', () => {
		// session-manager injects OPENAI_API_KEY for these itself rather than via
		// resolveLlmRoute — but that injection is inside `if (byollmAllowed)`. An
		// unentitled workspace therefore gets no env at all, which is exactly the
		// gap the pre-flight exists to catch; treating the key as "configured"
		// here would let it launch credential-less.
		//
		// Run WITH the operator's OpenRouter key set, i.e. production. An agent
		// key on a non-anthropic provider makes resolveLlmRoute return null
		// BEFORE it reaches the Maskin plan, so the plan is not a route for this
		// agent and must not rescue the gate. Checking step 5 anyway is how this
		// shape used to pass and then launch with no LLM env at all.
		const gap = preflightLlmCredentials({
			wsSettings: {},
			agent: { provider: 'openai', apiKey: 'sk-openai' },
			byollmAllowed: false,
			env: { MASKIN_FALLBACK_OPENROUTER_KEY: 'sk-or-operator' },
		})
		expect(gap).not.toBeNull()
		expect(gap?.detail).toMatch(/not entitled/i)
	})

	it('fails an agent key on a provider Maskin cannot inject', () => {
		// `llmProvider` is free text. resolveLlmRoute handles only anthropic here
		// and session-manager injects only openai, so a third provider has no
		// injection site anywhere — it would launch with no credential env.
		const gap = preflightLlmCredentials({
			wsSettings: {},
			agent: { provider: 'cohere', apiKey: 'sk-cohere' },
			byollmAllowed: true,
			env: { MASKIN_FALLBACK_OPENROUTER_KEY: 'sk-or-operator' },
		})
		expect(gap).not.toBeNull()
		expect(gap?.detail).toMatch(/cohere/i)
	})

	it('still lets an unentitled ANTHROPIC agent key fall through to the Maskin plan', () => {
		// The mirror of the two above: resolveLlmRoute's anthropic branch does
		// NOT early-return when the workspace is unentitled — it falls through to
		// routes 2-5, so the plan can still carry the session. Refusing here
		// would ground every trial workspace whose agent happens to hold a key.
		expect(
			preflightLlmCredentials({
				wsSettings: { billing: { plan: 'trial' } },
				agent: { provider: 'anthropic', apiKey: 'sk-ant-agent' },
				byollmAllowed: false,
				env: { MASKIN_FALLBACK_OPENROUTER_KEY: 'sk-or-operator' },
			}),
		).toBeNull()
	})

	it('passes a non-anthropic agent key when the workspace IS entitled', () => {
		expect(
			preflightLlmCredentials({
				wsSettings: {},
				agent: { provider: 'openai', apiKey: 'sk-openai' },
				byollmAllowed: true,
				env: noEnv,
			}),
		).toBeNull()
	})

	it('passes a workspace holding only an OpenAI key', () => {
		// Injected by session-manager after resolveLlmRoute returns, so it never
		// appears in that ladder — but it is a real route and must not be
		// refused a launch.
		expect(
			preflightLlmCredentials({
				wsSettings: { llm_keys: { openai: 'sk-openai-ws' } },
				agent: {},
				byollmAllowed: true,
				env: noEnv,
			}),
		).toBeNull()
	})

	it('passes when the ACTIVE Claude OAuth slot holds data', () => {
		expect(
			preflightLlmCredentials({
				wsSettings: {
					claude_oauth: {
						primary: {
							encryptedAccessToken: 'a',
							encryptedRefreshToken: 'r',
							expiresAt: Date.now() + 3_600_000,
						},
						failover: { active_slot: 'primary' },
					},
				},
				agent: {},
				byollmAllowed: true,
				env: noEnv,
			}),
		).toBeNull()
	})

	it('fails when active_slot points at an unconfigured slot and failover is ON', () => {
		// The incident shape: `claude_oauth` exists on the row, so a naive
		// truthiness check reads as "connected", but the slot actually selected
		// for the next launch has nothing in it.
		const gap = preflightLlmCredentials({
			wsSettings: {
				claude_oauth: { primary: slotData(), failover: { active_slot: 'backup' } },
			},
			agent: {},
			byollmAllowed: true,
			env: failoverEnv,
		})
		expect(gap).not.toBeNull()
		expect(gap?.humanMessage).toMatch(/no LLM credentials/i)
	})

	it('passes on a stale active_slot: backup once failover is switched OFF', () => {
		// The kill-switch path. resolveClaudeCredentialsWithFailover ignores
		// `active_slot` when the flag is off and reads `primary` directly, so a
		// workspace left on backup by an earlier failover still routes. Checking
		// `active_slot` unconditionally here would permanently refuse to launch
		// the very workspaces the switch was thrown to rescue.
		expect(
			preflightLlmCredentials({
				wsSettings: {
					claude_oauth: { primary: slotData(), failover: { active_slot: 'backup' } },
				},
				agent: {},
				byollmAllowed: true,
				env: noEnv,
			}),
		).toBeNull()
	})

	it('fails with failover OFF when only a backup slot is configured', () => {
		// Mirror image: the flag-off resolver reads `primary` and nothing else,
		// so a backup-only workspace genuinely has no OAuth route.
		const gap = preflightLlmCredentials({
			wsSettings: {
				claude_oauth: { backup: slotData(), failover: { active_slot: 'backup' } },
			},
			agent: {},
			byollmAllowed: true,
			env: noEnv,
		})
		expect(gap).not.toBeNull()
	})

	it('passes on a complete custom_llm config and fails on a partial one', () => {
		const complete = {
			custom_llm: {
				enabled: true,
				base_url: 'https://openrouter.ai/api',
				api_key: 'sk-or',
				model: 'deepseek/deepseek-v4-flash',
			},
		}
		expect(
			preflightLlmCredentials({
				wsSettings: complete,
				agent: {},
				byollmAllowed: true,
				env: noEnv,
			}),
		).toBeNull()

		// Same bar as buildCustomLlmEnv — a config missing its model is skipped
		// there, so it must not count as configured here either.
		expect(
			preflightLlmCredentials({
				wsSettings: { custom_llm: { ...complete.custom_llm, model: '' } },
				agent: {},
				byollmAllowed: true,
				env: noEnv,
			}),
		).not.toBeNull()
	})

	it('passes on a workspace anthropic key', () => {
		expect(
			preflightLlmCredentials({
				wsSettings: { llm_keys: { anthropic: 'sk-ant-ws' } },
				agent: {},
				byollmAllowed: true,
				env: noEnv,
			}),
		).toBeNull()
	})

	it('ignores BYO credentials when the workspace is not entitled', () => {
		// resolveLlmRoute only *reaches* routes 1-4 when entitled, so a stored
		// key on a non-entitled workspace is not a route. With no funded plan
		// configured either, that workspace has nowhere to go.
		const gap = preflightLlmCredentials({
			wsSettings: { llm_keys: { anthropic: 'sk-ant-ws' } },
			agent: {},
			byollmAllowed: false,
			env: noEnv,
		})
		expect(gap).not.toBeNull()
		expect(gap?.detail).toMatch(/not entitled/i)
	})

	it('passes on the Maskin plan route when the operator key is configured', () => {
		expect(
			preflightLlmCredentials({
				wsSettings: { billing: { plan: 'pro' } },
				agent: {},
				byollmAllowed: false,
				env: { MASKIN_FALLBACK_OPENROUTER_KEY: 'sk-or-operator' },
			}),
		).toBeNull()
	})

	it('fails when nothing at all is configured', () => {
		const gap = preflightLlmCredentials({
			wsSettings: {},
			agent: {},
			byollmAllowed: true,
			env: noEnv,
		})
		expect(gap).not.toBeNull()
		expect(gap?.detail).toMatch(/No Claude subscription/i)
	})
})

describe('resolveChatCredentials — system fallback entitlement', () => {
	it('does not fall back to the Maskin OpenRouter key on the byollm plan', () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
		expect(
			resolveChatCredentials({
				wsSettings: { billing: { plan: 'byollm' } } as WorkspaceSettings,
				agent: { provider: null, apiKey: null, model: null },
			}),
		).toBeNull()
	})

	it('still uses the byollm workspace own credentials when configured', () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
		const creds = resolveChatCredentials({
			wsSettings: {
				billing: { plan: 'byollm' },
				llm_keys: { anthropic: 'sk-ant-workspace' },
			} as WorkspaceSettings,
			agent: { provider: null, apiKey: null, model: null },
		})
		expect(creds).toEqual({
			provider: 'anthropic',
			apiKey: 'sk-ant-workspace',
			model: expect.any(String),
		})
	})

	it('still falls back for a Maskin-funded plan', () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
		const creds = resolveChatCredentials({
			wsSettings: { billing: { plan: 'pro' } } as WorkspaceSettings,
			agent: { provider: null, apiKey: null, model: null },
		})
		expect(creds?.apiKey).toBe('sk-or-maskin')
	})

	it('still falls back when no billing block exists (defaults to trial)', () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-maskin'
		const creds = resolveChatCredentials({
			wsSettings: {},
			agent: { provider: null, apiKey: null, model: null },
		})
		expect(creds?.apiKey).toBe('sk-or-maskin')
	})
})
