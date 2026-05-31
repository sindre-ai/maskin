import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { getValidOAuthToken } from './claude-oauth'
import type { WorkspaceSettings } from './types'

/**
 * Tag persisted on `sessions.config.llm_route` so we can later attribute usage
 * (and enforce per-actor quotas) for sessions that ran on the system fallback.
 */
export const LLM_ROUTE_SYSTEM_FALLBACK = 'system_fallback'
export const LLM_ROUTE_CUSTOM = 'workspace_custom'
export const LLM_ROUTE_OAUTH = 'claude_oauth'
export const LLM_ROUTE_API_KEY = 'workspace_api_key'
export const LLM_ROUTE_AGENT = 'agent_api_key'
export const LLM_ROUTE_MASKIN_PLAN = 'maskin_plan'

export type LlmRoute =
	| typeof LLM_ROUTE_SYSTEM_FALLBACK
	| typeof LLM_ROUTE_CUSTOM
	| typeof LLM_ROUTE_OAUTH
	| typeof LLM_ROUTE_API_KEY
	| typeof LLM_ROUTE_AGENT
	| typeof LLM_ROUTE_MASKIN_PLAN

/**
 * Workspaces on these plans are routed through Maskin's funded OR account.
 * Includes `trial` so trial workspaces share the same routing tag and the same
 * pre-flight cap check (with a smaller, env-overridable bucket).
 */
const MASKIN_PLAN_HOSTED_PLANS = new Set(['trial', 'starter', 'pro'])

/**
 * Default trial bucket. Sized for ~50 messages at ~2k tokens each — enough to
 * give a new user a real feel for the product without underwriting unbounded
 * usage. Operators can override via MASKIN_TRIAL_HARD_CAP_TOKENS; Stripe-paid
 * tiers always read `billing.hard_cap_tokens` written by the webhook.
 */
const TRIAL_DEFAULT_HARD_CAP_TOKENS = 100_000

/** Period length for paid-plan caps. Matches the monthly billing cadence. */
const PLAN_CAP_PERIOD_SECONDS = 30 * 24 * 60 * 60

export type HostedPlan = 'trial' | 'starter' | 'pro'

export interface LlmRoutingResult {
	route: LlmRoute
	/** Env vars to merge into the container environment. */
	envVars: Record<string, string>
}

export interface FallbackConfig {
	apiKey?: string
	baseUrl?: string
	model?: string
	smallModel?: string
	dailyTokenLimit: number
}

export interface AgentLlmConfig {
	provider?: string | null
	apiKey?: string | null
}

/**
 * Reads MASKIN_FALLBACK_* env vars once. The fallback is only "available" when
 * the operator has set MASKIN_FALLBACK_OPENROUTER_KEY — otherwise we skip the
 * fallback path and let the session fail with a clearer "no credentials" error
 * upstream.
 */
export function readFallbackConfig(env: NodeJS.ProcessEnv = process.env): FallbackConfig {
	const rawLimit = Number(env.MASKIN_FALLBACK_DAILY_TOKEN_LIMIT)
	const dailyTokenLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 550_000
	return {
		apiKey: env.MASKIN_FALLBACK_OPENROUTER_KEY?.trim() || undefined,
		baseUrl: env.MASKIN_FALLBACK_BASE_URL?.trim() || 'https://openrouter.ai/api',
		model: env.MASKIN_FALLBACK_MODEL?.trim() || 'deepseek/deepseek-v4-flash',
		smallModel:
			env.MASKIN_FALLBACK_SMALL_MODEL?.trim() ||
			env.MASKIN_FALLBACK_MODEL?.trim() ||
			'deepseek/deepseek-v4-flash',
		dailyTokenLimit,
	}
}

/**
 * Sums input+output tokens across the actor's last-24h sessions that ran on
 * the system fallback route. Used to enforce MASKIN_FALLBACK_DAILY_TOKEN_LIMIT.
 *
 * `null` means "we couldn't measure" — caller should treat conservatively.
 */
export async function getActorFallbackTokenUsage24h(
	db: Database,
	actorId: string,
): Promise<number> {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
	const rows = await db
		.select({
			inputTokens: sessions.inputTokens,
			outputTokens: sessions.outputTokens,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.actorId, actorId),
				gte(sessions.createdAt, since),
				sql`${sessions.config}->>'llm_route' = ${LLM_ROUTE_SYSTEM_FALLBACK}`,
			),
		)

	let total = 0
	for (const row of rows) {
		total += row.inputTokens ?? 0
		total += row.outputTokens ?? 0
	}
	return total
}

export class FallbackQuotaExceededError extends Error {
	constructor(
		readonly used: number,
		readonly limit: number,
	) {
		super(
			`Free fallback quota exceeded: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens used in the last 24 hours. Add a Claude subscription, an Anthropic API key, or a custom model endpoint in workspace settings → keys.`,
		)
		this.name = 'FallbackQuotaExceededError'
	}
}

/**
 * Thrown when a workspace on a Maskin-hosted plan (trial/starter/pro) has burned
 * through its current-period token cap. Routes that resolve to `maskin_plan`
 * run a pre-flight sum of `sessions.config.llm_route='maskin_plan'` rows since
 * `billing.period_start` and refuse if `used >= cap`. The caller maps this to
 * an HTTP 402 with `{plan, used, cap, period_end}` so the over-cap banner can
 * render an ETA and the right upgrade CTA.
 *
 * `periodEndSeconds` is null for trial workspaces — trial caps don't auto-reset;
 * the only way to lift them is upgrading. For starter/pro it's
 * `period_start + 30 days`, an approximation of the Stripe billing cycle that
 * matches what the webhook will eventually persist explicitly.
 */
export class PlanCapExceededError extends Error {
	readonly code = 'PLAN_CAP_EXCEEDED'
	readonly httpStatus = 402

	constructor(
		readonly plan: HostedPlan,
		readonly used: number,
		readonly cap: number,
		readonly periodEndSeconds: number | null,
	) {
		super(
			`Plan cap exceeded for ${plan}: ${used.toLocaleString()} of ${cap.toLocaleString()} tokens used this period.`,
		)
		this.name = 'PlanCapExceededError'
	}
}

/**
 * Validates a workspace's custom_llm config. Returns the env vars to inject,
 * or null if the config is incomplete (which the caller treats as "skip,
 * fall through to the next route").
 *
 * Required: enabled=true + base_url + api_key + model. small_fast_model is
 * optional and falls back to model.
 */
function buildCustomLlmEnv(custom: WorkspaceSettings['custom_llm']): Record<string, string> | null {
	if (!custom?.enabled) return null
	const baseUrl = custom.base_url?.trim()
	const apiKey = custom.api_key?.trim()
	const model = custom.model?.trim()
	if (!baseUrl || !apiKey || !model) return null
	const smallModel = custom.small_fast_model?.trim() || model
	return {
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_AUTH_TOKEN: apiKey,
		// Force-clear ANTHROPIC_API_KEY so Claude Code uses ANTHROPIC_AUTH_TOKEN's
		// bearer-token path instead of x-api-key (Morph guide caveat).
		ANTHROPIC_API_KEY: '',
		ANTHROPIC_MODEL: model,
		ANTHROPIC_SMALL_FAST_MODEL: smallModel,
	}
}

/**
 * Builds the env vars for the Maskin-funded OpenRouter route — same shape as
 * the system fallback (we reuse the operator's MASKIN_FALLBACK_* config so a
 * single OR account underwrites trial, starter, and pro). Returns null when
 * the workspace is not on a hosted plan or the operator hasn't configured the
 * OR key.
 */
function buildMaskinPlanEnv(
	billing: WorkspaceSettings['billing'],
	fallback: FallbackConfig,
): Record<string, string> | null {
	if (!billing || !MASKIN_PLAN_HOSTED_PLANS.has(billing.plan)) return null
	if (!fallback.apiKey) return null
	return {
		ANTHROPIC_BASE_URL: fallback.baseUrl ?? 'https://openrouter.ai/api',
		ANTHROPIC_AUTH_TOKEN: fallback.apiKey,
		ANTHROPIC_API_KEY: '',
		ANTHROPIC_MODEL: fallback.model ?? 'deepseek/deepseek-v4-flash',
		ANTHROPIC_SMALL_FAST_MODEL:
			fallback.smallModel ?? fallback.model ?? 'deepseek/deepseek-v4-flash',
	}
}

/**
 * Sums input+output tokens across the workspace's current-period sessions that
 * ran on the maskin_plan route. Counts every session tagged
 * `config.llm_route='maskin_plan'` with `createdAt >= period_start` so usage
 * accrues across the workspace, not per-actor — the cap is a workspace concept.
 */
export async function getWorkspaceMaskinPlanTokenUsage(
	db: Database,
	workspaceId: string,
	periodStartSeconds: number,
): Promise<number> {
	const since = new Date(periodStartSeconds * 1000)
	const rows = await db
		.select({
			inputTokens: sessions.inputTokens,
			outputTokens: sessions.outputTokens,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, workspaceId),
				gte(sessions.createdAt, since),
				sql`${sessions.config}->>'llm_route' = ${LLM_ROUTE_MASKIN_PLAN}`,
			),
		)

	let total = 0
	for (const row of rows) {
		total += row.inputTokens ?? 0
		total += row.outputTokens ?? 0
	}
	return total
}

/**
 * Resolves the hard-cap and period-start for a hosted-plan workspace.
 *
 * - `trial`: `billing.hard_cap_tokens` if the operator pinned one, else the
 *   env-overridable default. period_start defaults to epoch when missing so
 *   all maskin_plan sessions count (trial workspaces don't have a Stripe
 *   billing cycle yet).
 * - `starter`/`pro`: `billing.hard_cap_tokens` written by the Stripe webhook.
 *   Falls back to 0 (fail closed) when the webhook hasn't populated it — better
 *   to 402 the user with a "contact support" surface than silently underwrite
 *   unlimited usage. Same for missing period_start.
 */
function resolvePlanCap(
	billing: NonNullable<WorkspaceSettings['billing']>,
	env: NodeJS.ProcessEnv,
): { cap: number; periodStartSeconds: number; periodEndSeconds: number | null } {
	const periodStartSeconds = billing.period_start ?? 0
	if (billing.plan === 'trial') {
		const cap = billing.hard_cap_tokens ?? readTrialHardCap(env)
		return { cap, periodStartSeconds, periodEndSeconds: null }
	}
	const cap = billing.hard_cap_tokens ?? 0
	return {
		cap,
		periodStartSeconds,
		periodEndSeconds: periodStartSeconds + PLAN_CAP_PERIOD_SECONDS,
	}
}

function readTrialHardCap(env: NodeJS.ProcessEnv): number {
	const raw = Number(env.MASKIN_TRIAL_HARD_CAP_TOKENS)
	return Number.isFinite(raw) && raw > 0 ? raw : TRIAL_DEFAULT_HARD_CAP_TOKENS
}

/**
 * Pre-flight check: if the workspace is on a hosted plan and is at or above
 * its current-period token cap, throw `PlanCapExceededError`. No-op when the
 * workspace isn't on a hosted plan, so it's safe to call unconditionally
 * before session creation.
 *
 * Defense-in-depth: `resolveLlmRoute` also calls this on the maskin_plan
 * branch, so any code path that reaches routing without a pre-flight still
 * gets blocked — just later, after the session row exists.
 */
export async function assertWithinMaskinPlanCap(
	db: Database,
	workspaceId: string,
	billing: WorkspaceSettings['billing'] | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!billing || !MASKIN_PLAN_HOSTED_PLANS.has(billing.plan)) return
	const { cap, periodStartSeconds, periodEndSeconds } = resolvePlanCap(billing, env)
	const used = await getWorkspaceMaskinPlanTokenUsage(db, workspaceId, periodStartSeconds)
	if (used >= cap) {
		throw new PlanCapExceededError(billing.plan as HostedPlan, used, cap, periodEndSeconds)
	}
}

/**
 * Resolves which LLM the session should use, in priority order:
 *
 *   1. Agent-level api_key (caller-injected override)
 *   2. Maskin hosted plan (`settings.billing.plan ∈ {trial, starter, pro}`)
 *   3. Workspace custom_llm (BYO endpoint — OpenRouter, Ollama, vLLM, …)
 *   4. Workspace Claude OAuth (Pro/Max/Teams subscription)
 *   5. Workspace anthropic api_key (`settings.llm_keys.anthropic`)
 *   6. System fallback (MASKIN_FALLBACK_OPENROUTER_KEY) with daily quota
 *
 * Throws PlanCapExceededError if route #2 is selected and the workspace is at
 * or over its current-period cap; FallbackQuotaExceededError if route #6 is
 * selected and the actor has already burned through their 24h budget.
 *
 * Returns null if the agent uses a non-anthropic provider (e.g. OpenAI native);
 * caller continues to handle OPENAI_API_KEY injection itself.
 */
export async function resolveLlmRoute(params: {
	db: Database
	workspaceId: string
	actorId: string
	wsSettings: WorkspaceSettings
	agent: AgentLlmConfig
}): Promise<LlmRoutingResult | null> {
	const { db, workspaceId, actorId, wsSettings, agent } = params

	// 1. Agent-level override — only handled here for anthropic; non-anthropic
	//    providers fall through to caller (matches existing behavior).
	if (agent.apiKey) {
		if (agent.provider === 'anthropic') {
			return {
				route: LLM_ROUTE_AGENT,
				envVars: { ANTHROPIC_API_KEY: agent.apiKey },
			}
		}
		// caller (session-manager) handles OPENAI_API_KEY etc.
		return null
	}

	// Read once and share with the system-fallback branch below.
	const fallback = readFallbackConfig()

	// 2. Maskin hosted plan — trial/starter/pro workspaces are routed through
	//    Maskin's funded OR account; the route tag is what makes per-period
	//    usage queryable downstream (the credits banner and this branch's own
	//    pre-flight cap check both read `sessions.config.llm_route =
	//    'maskin_plan'`). Throws PlanCapExceededError when over-cap so the
	//    container is never spun up against an exhausted plan.
	const maskinPlanEnv = buildMaskinPlanEnv(wsSettings.billing, fallback)
	if (maskinPlanEnv) {
		await assertWithinMaskinPlanCap(db, workspaceId, wsSettings.billing)
		return { route: LLM_ROUTE_MASKIN_PLAN, envVars: maskinPlanEnv }
	}

	// 3. Workspace custom_llm
	const customEnv = buildCustomLlmEnv(wsSettings.custom_llm)
	if (customEnv) {
		return { route: LLM_ROUTE_CUSTOM, envVars: customEnv }
	}

	// 4. Claude OAuth subscription
	try {
		const oauthResult = await getValidOAuthToken(db, workspaceId)
		if (oauthResult) {
			const envVars: Record<string, string> = {
				CLAUDE_OAUTH_ACCESS_TOKEN: oauthResult.tokens.accessToken,
				CLAUDE_OAUTH_REFRESH_TOKEN: oauthResult.tokens.refreshToken,
				CLAUDE_OAUTH_EXPIRES_AT: String(oauthResult.tokens.expiresAt),
			}
			if (oauthResult.tokens.scopes) {
				envVars.CLAUDE_OAUTH_SCOPES = JSON.stringify(oauthResult.tokens.scopes)
			}
			if (oauthResult.tokens.subscriptionType) {
				envVars.CLAUDE_OAUTH_SUBSCRIPTION_TYPE = oauthResult.tokens.subscriptionType
			}
			return { route: LLM_ROUTE_OAUTH, envVars }
		}
	} catch {
		// Swallow OAuth errors and let the next route take over — the warning
		// is logged by the caller for parity with the previous behavior.
	}

	// 5. Workspace anthropic api key
	const wsAnthropic = wsSettings.llm_keys?.anthropic
	if (wsAnthropic) {
		return {
			route: LLM_ROUTE_API_KEY,
			envVars: { ANTHROPIC_API_KEY: wsAnthropic },
		}
	}

	// 6. System fallback (re-uses the `fallback` config already read above)
	if (!fallback.apiKey) return null
	const used = await getActorFallbackTokenUsage24h(db, actorId)
	if (used >= fallback.dailyTokenLimit) {
		throw new FallbackQuotaExceededError(used, fallback.dailyTokenLimit)
	}
	return {
		route: LLM_ROUTE_SYSTEM_FALLBACK,
		envVars: {
			ANTHROPIC_BASE_URL: fallback.baseUrl ?? 'https://openrouter.ai/api',
			ANTHROPIC_AUTH_TOKEN: fallback.apiKey,
			ANTHROPIC_API_KEY: '',
			ANTHROPIC_MODEL: fallback.model ?? 'deepseek/deepseek-v4-flash',
			ANTHROPIC_SMALL_FAST_MODEL:
				fallback.smallModel ?? fallback.model ?? 'deepseek/deepseek-v4-flash',
		},
	}
}
