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

export const LLM_ROUTE_CUSTOM = 'workspace_custom'
export const LLM_ROUTE_OAUTH = 'claude_oauth'
export const LLM_ROUTE_API_KEY = 'workspace_api_key'
export const LLM_ROUTE_AGENT = 'agent_api_key'
export const LLM_ROUTE_MASKIN_PLAN = 'maskin_plan'

export type LlmRoute =
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
}

export interface AgentLlmConfig {
	provider?: string | null
	apiKey?: string | null
}

/**
 * Reads MASKIN_FALLBACK_* env vars that configure the operator's OpenRouter
 * account used for the maskin_plan route. Only "available" when
 * MASKIN_FALLBACK_OPENROUTER_KEY is set.
 */
export function readFallbackConfig(env: NodeJS.ProcessEnv = process.env): FallbackConfig {
	return {
		apiKey: env.MASKIN_FALLBACK_OPENROUTER_KEY?.trim() || undefined,
		baseUrl: env.MASKIN_FALLBACK_BASE_URL?.trim() || 'https://openrouter.ai/api',
		model: env.MASKIN_FALLBACK_MODEL?.trim() || 'deepseek/deepseek-v4-flash',
		smallModel:
			env.MASKIN_FALLBACK_SMALL_MODEL?.trim() ||
			env.MASKIN_FALLBACK_MODEL?.trim() ||
			'deepseek/deepseek-v4-flash',
	}
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

export function getWorkspacePlanCap(wsSettings: WorkspaceSettings): number | null {
	const billing = wsSettings.billing
	const plan = (billing?.plan ?? 'trial') as MaskinPlan | 'byollm'
	if (!MASKIN_PLAN_ROUTED_PLANS.has(plan)) return null
	return effectivePlanCap(plan as MaskinPlan, billing?.hard_cap_tokens ?? undefined)
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
	const cap = effectivePlanCap(maskinPlan, billing?.hard_cap_tokens ?? undefined)
	if (cap === null) return

	const used = await getWorkspacePlanTokenUsage(
		params.db,
		params.workspaceId,
		billing?.period_start ?? undefined,
	)
	if (used < cap) return

	throw new PlanCapExceededError({
		plan: maskinPlan,
		used,
		cap,
		periodEnd: effectivePeriodEnd(
			billing?.period_start ?? undefined,
			billing?.period_end ?? undefined,
		),
	})
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
 * Builds the env vars for the Maskin-funded OpenRouter route. Returns null
 * when the workspace is not on a maskin-plan-routed plan or the operator
 * hasn't configured the OR key.
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
 *
 * BYO credentials (2-4) always take precedence over the Maskin-funded route so
 * a connected Claude subscription or custom endpoint is never bypassed and never
 * counts against the workspace's token cap. Returns null when no credentials are
 * available (session fails to start rather than silently consuming Maskin tokens).
 *
 * Returns null if the agent uses a non-anthropic provider (e.g. OpenAI native);
 * caller continues to handle OPENAI_API_KEY injection itself.
 */
export async function resolveLlmRoute(params: {
	db: Database
	workspaceId: string
	wsSettings: WorkspaceSettings
	agent: AgentLlmConfig
}): Promise<LlmRoutingResult | null> {
	const { db, workspaceId, wsSettings, agent } = params

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

	// 5. Maskin plan (starter/pro/trial) — routed through Maskin's funded OR
	//    account. Only reached when no BYO credentials are present so tokens are
	//    never counted against the cap when the user has their own LLM configured.
	//    The cap check here is defense-in-depth; the pre-flight in `createSession`
	//    is what surfaces 402 to the user before a session row is created.
	const fallback = readFallbackConfig()
	const maskinPlanEnv = buildMaskinPlanEnv(wsSettings.billing, fallback)
	if (maskinPlanEnv) {
		await checkPlanCap({ db, workspaceId, wsSettings })
		return { route: LLM_ROUTE_MASKIN_PLAN, envVars: maskinPlanEnv }
	}

	return null
}
