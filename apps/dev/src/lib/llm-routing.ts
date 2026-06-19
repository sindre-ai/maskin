import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import {
	DEFAULT_PERIOD_LENGTH_MS,
	TRIAL_HARD_CAP_DEFAULT_TOKENS,
	parsePositiveIntEnv,
} from './billing-defaults'
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
 * Trial is included so BYOLLM-less users can try the product without their
 * own credentials — capped low via `MASKIN_TRIAL_HARD_CAP_TOKENS`.
 */
const MASKIN_PLAN_ROUTED_PLANS = new Set(['starter', 'pro', 'trial'])

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
	const dailyTokenLimit = parsePositiveIntEnv('MASKIN_FALLBACK_DAILY_TOKEN_LIMIT', env) ?? 550_000
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

/**
 * Sums input+output tokens across the workspace's maskin_plan sessions since
 * `periodStart` (or all-time when undefined — used for trial buckets that don't
 * have a billing period yet). The route filter is what makes paid + trial usage
 * cheap to query, even as the sessions table grows.
 */
export async function getWorkspacePlanTokenUsage(
	db: Database,
	workspaceId: string,
	periodStartMs?: number,
): Promise<number> {
	const conds = [
		eq(sessions.workspaceId, workspaceId),
		sql`${sessions.config}->>'llm_route' = ${LLM_ROUTE_MASKIN_PLAN}`,
	]
	if (periodStartMs !== undefined) {
		conds.push(gte(sessions.createdAt, new Date(periodStartMs)))
	}
	const rows = await db
		.select({
			inputTokens: sessions.inputTokens,
			outputTokens: sessions.outputTokens,
		})
		.from(sessions)
		.where(and(...conds))

	let total = 0
	for (const row of rows) {
		total += row.inputTokens ?? 0
		total += row.outputTokens ?? 0
	}
	return total
}

export type MaskinPlan = 'trial' | 'starter' | 'pro'

interface PlanCapContext {
	plan: MaskinPlan
	used: number
	cap: number
	periodEnd: number | null
}

/**
 * Surfaces as HTTP 402 with `{ code: 'PLAN_CAP_EXCEEDED', plan, used, cap,
 * period_end }`. The frontend (Task dcfe3afe) reads `period_end` to render a
 * reset ETA and a typed upgrade CTA.
 */
export class PlanCapExceededError extends Error {
	readonly plan: MaskinPlan
	readonly used: number
	readonly cap: number
	readonly periodEnd: number | null

	constructor(ctx: PlanCapContext) {
		super(
			`${ctx.plan} plan cap exceeded: ${ctx.used.toLocaleString()} of ${ctx.cap.toLocaleString()} tokens used this period.`,
		)
		this.name = 'PlanCapExceededError'
		this.plan = ctx.plan
		this.used = ctx.used
		this.cap = ctx.cap
		this.periodEnd = ctx.periodEnd
	}
}

function readTrialDefaultCap(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveIntEnv('MASKIN_TRIAL_HARD_CAP_TOKENS', env) ?? TRIAL_HARD_CAP_DEFAULT_TOKENS
}

/**
 * Returns the configured cap for a maskin_plan workspace, or `null` when no cap
 * applies (paid plan whose Stripe webhook hasn't written `hard_cap_tokens` yet
 * — we fail open until Task 5 lands).
 */
function effectivePlanCap(plan: MaskinPlan, hardCap: number | undefined): number | null {
	if (typeof hardCap === 'number' && hardCap >= 0) return hardCap
	if (plan === 'trial') return readTrialDefaultCap()
	return null
}

function effectivePeriodEnd(
	periodStartMs: number | undefined,
	periodEndMs: number | undefined,
): number | null {
	if (typeof periodEndMs === 'number') return periodEndMs
	if (typeof periodStartMs === 'number') return periodStartMs + DEFAULT_PERIOD_LENGTH_MS
	return null
}

/**
 * Pre-flight check on the maskin_plan route. Called from `createSession` so the
 * HTTP caller gets a 402 *before* a session row is created (the v1 contract
 * with the over-cap banner). Also invoked at route-resolution time as
 * defense-in-depth against background calls that skipped the pre-check.
 *
 * No-op when the workspace is not on a maskin-plan-routed plan or when no cap
 * applies (e.g., paid plan pre-Stripe). Throws `PlanCapExceededError` otherwise.
 */
export async function checkPlanCap(params: {
	db: Database
	workspaceId: string
	wsSettings: WorkspaceSettings
}): Promise<void> {
	const billing = params.wsSettings.billing
	const plan = (billing?.plan ?? 'trial') as MaskinPlan | 'byollm'
	if (!MASKIN_PLAN_ROUTED_PLANS.has(plan)) return

	const maskinPlan = plan as MaskinPlan
	const cap = effectivePlanCap(maskinPlan, billing?.hard_cap_tokens)
	if (cap === null) return

	const used = await getWorkspacePlanTokenUsage(params.db, params.workspaceId, billing?.period_start)
	if (used < cap) return

	throw new PlanCapExceededError({
		plan: maskinPlan,
		used,
		cap,
		periodEnd: effectivePeriodEnd(billing?.period_start, billing?.period_end),
	})
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
 * single OR account underwrites both the trial bucket and paid plans). Returns
 * null when the workspace is not on a paid plan or the operator hasn't
 * configured the OR key.
 */
function buildMaskinPlanEnv(
	billing: WorkspaceSettings['billing'],
	fallback: FallbackConfig,
): Record<string, string> | null {
	const plan = billing?.plan ?? 'trial'
	if (!MASKIN_PLAN_ROUTED_PLANS.has(plan)) return null
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
 * Resolves which LLM the session should use, in priority order:
 *
 *   1. Agent-level api_key (caller-injected override)
 *   2. Workspace Claude OAuth (Pro/Max/Teams subscription)
 *   3. Workspace custom_llm (BYO endpoint — OpenRouter, Ollama, vLLM, …)
 *   4. Workspace anthropic api_key (`settings.llm_keys.anthropic`)
 *   5. Maskin plan (starter/pro/trial) — Maskin's funded OR account, counts against cap
 *   6. System fallback (MASKIN_FALLBACK_OPENROUTER_KEY) with daily quota
 *
 * BYO credentials (2-4) always take precedence over the Maskin-funded route so
 * a connected Claude subscription or custom endpoint is never bypassed and never
 * counts against the workspace's token cap.
 *
 * Throws FallbackQuotaExceededError if route #6 is selected and the actor has
 * already burned through their 24h budget.
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

	// 2. Claude OAuth subscription — checked first among BYO routes so a
	//    connected Pro/Max subscription is always preferred over custom endpoints
	//    and never consumes maskin plan tokens.
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

	// 3. Workspace custom_llm
	const customEnv = buildCustomLlmEnv(wsSettings.custom_llm)
	if (customEnv) {
		return { route: LLM_ROUTE_CUSTOM, envVars: customEnv }
	}

	// 4. Workspace anthropic api key
	const wsAnthropic = wsSettings.llm_keys?.anthropic
	if (wsAnthropic) {
		return {
			route: LLM_ROUTE_API_KEY,
			envVars: { ANTHROPIC_API_KEY: wsAnthropic },
		}
	}

	// Read once and share between the maskin_plan and system-fallback branches.
	const fallback = readFallbackConfig()

	// 5. Maskin plan (starter/pro/trial) — routed through Maskin's funded OR
	//    account. Only reached when no BYO credentials are present so tokens are
	//    never counted against the cap when the user has their own LLM configured.
	//    The cap check here is defense-in-depth; the pre-flight in `createSession`
	//    is what surfaces 402 to the user before a session row is created.
	const maskinPlanEnv = buildMaskinPlanEnv(wsSettings.billing, fallback)
	if (maskinPlanEnv) {
		await checkPlanCap({ db, workspaceId, wsSettings })
		return { route: LLM_ROUTE_MASKIN_PLAN, envVars: maskinPlanEnv }
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
