import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import {
	DEFAULT_PERIOD_LENGTH_MS,
	TRIAL_HARD_CAP_DEFAULT_TOKENS,
	parsePositiveIntEnv,
} from './billing-defaults'
import { type SubscriptionProbe, resolveClaudeCredentialsWithFailover } from './claude-failover'
import type { OAuthSlotKind } from './claude-oauth-slots'
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
const MASKIN_PLAN_ROUTED_PLANS = new Set(['pro', 'team', 'trial'])

export interface LlmRoutingResult {
	route: LlmRoute
	/** Env vars to merge into the container environment. */
	envVars: Record<string, string>
	oauthSlot?: OAuthSlotKind
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
	model?: string | null
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

export type MaskinPlan = 'trial' | 'pro' | 'team'

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
 * True once a workspace may keep running past its hard cap and get billed
 * per-block overage instead of being blocked. Trial never qualifies — overage
 * requires a paid plan with a card on file, which is what `overage_enabled`
 * (written by the Stripe webhook once the metered line item is confirmed on
 * the subscription) and an `active` status together represent. `past_due`/
 * `canceled` intentionally still hard-block: a workspace that can't be billed
 * for its base plan shouldn't be allowed to run up unbillable overage either.
 */
export function canUseOverage(plan: MaskinPlan, billing: WorkspaceSettings['billing']): boolean {
	if (plan === 'trial') return false
	return billing?.overage_enabled === true && billing?.status === 'active'
}

/**
 * Pre-flight check on the maskin_plan route. Called from `createSession` so the
 * HTTP caller gets a 402 *before* a session row is created (the v1 contract
 * with the over-cap banner). Also invoked at route-resolution time as
 * defense-in-depth against background calls that skipped the pre-check.
 *
 * No-op when the workspace is not on a maskin-plan-routed plan or when no cap
 * applies (e.g., paid plan pre-Stripe). Throws `PlanCapExceededError` when the
 * cap is exceeded and overage billing isn't available for this workspace
 * (`canUseOverage`) — otherwise lets the caller through; actual overage usage
 * is metered separately at session-completion time (`lib/overage-billing.ts`).
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

	// billing.period_start / period_end are Unix SECONDS (Stripe writes them
	// straight from current_period_start/end). Convert to ms before passing to
	// getWorkspacePlanTokenUsage (which feeds new Date()) and effectivePeriodEnd.
	const periodStartMs =
		typeof billing?.period_start === 'number' ? billing.period_start * 1000 : undefined
	const periodEndMs =
		typeof billing?.period_end === 'number' ? billing.period_end * 1000 : undefined

	const used = await getWorkspacePlanTokenUsage(params.db, params.workspaceId, periodStartMs)
	if (used < cap) return
	if (canUseOverage(maskinPlan, billing)) return

	throw new PlanCapExceededError({
		plan: maskinPlan,
		used,
		cap,
		periodEnd: effectivePeriodEnd(periodStartMs, periodEndMs),
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
 *   5. Maskin plan (pro/team/trial) — Maskin's funded OR account, counts against cap
 *
 * BYO credentials (1-4) always take precedence over the Maskin-funded route so
 * a connected Claude subscription or custom endpoint is never bypassed and never
 * counts against the workspace's token cap. Returns null when no credentials are
 * available (session fails to start rather than silently consuming Maskin tokens).
 *
 * Routes 1 (anthropic branch only), 2, 3, and 4 are all BYO credentials and are
 * only reachable when `byollmAllowed` is true — every workspace defaults to the
 * Maskin plan, and only ops-flagged exception workspaces may bring their own
 * Claude subscription / endpoint / key. See PR #970.
 *
 * Returns null if the agent uses a non-anthropic provider (e.g. OpenAI native);
 * caller continues to handle OPENAI_API_KEY injection itself (also gated on
 * `byollmAllowed` — see session-manager.ts).
 *
 * `agent.model`, when set, is forwarded as ANTHROPIC_MODEL on routes #1, #3,
 * and #4 (the routes that don't already carry an explicit model of their
 * own). Routes #2 and #5 already source their model from workspace/operator
 * config and are left as-is.
 */
export async function resolveLlmRoute(params: {
	db: Database
	workspaceId: string
	actorId: string
	wsSettings: WorkspaceSettings
	agent: AgentLlmConfig
	/** Workspace entitlement to BYO LLM credentials. Defaults false. */
	byollmAllowed: boolean
	/**
	 * Overrides the default `probeClaudeSubscription` probe used by the
	 * failover path when `MASKIN_CLAUDE_FAILOVER_ENABLED=true`. Only tests
	 * need to pass this — production callers can omit it and
	 * `resolveClaudeCredentialsWithFailover` falls back to the real
	 * Anthropic Messages API probe.
	 */
	claudeProbe?: SubscriptionProbe
}): Promise<LlmRoutingResult | null> {
	const { db, workspaceId, actorId, wsSettings, agent, byollmAllowed, claudeProbe } = params

	// 1. Agent-level override — only handled here for anthropic; non-anthropic
	//    providers fall through to caller (matches existing behavior). The
	//    anthropic branch is a BYO credential, so it's gated like routes 2-4.
	if (agent.apiKey) {
		if (agent.provider === 'anthropic') {
			if (byollmAllowed) {
				const envVars: Record<string, string> = { ANTHROPIC_API_KEY: agent.apiKey }
				if (agent.model) {
					envVars.ANTHROPIC_MODEL = agent.model
				}
				return { route: LLM_ROUTE_AGENT, envVars }
			}
		} else {
			// caller (session-manager) handles OPENAI_API_KEY etc.
			return null
		}
	}

	if (byollmAllowed) {
		// 2. Claude OAuth subscription — checked first among BYO routes so a
		//    connected Pro/Max subscription is always preferred over custom endpoints
		//    and never consumes maskin plan tokens. Primary→backup failover kicks in
		//    when MASKIN_CLAUDE_FAILOVER_ENABLED is set; otherwise legacy
		//    primary-only behaviour applies.
		try {
			const oauthResult = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId,
				actorId,
				probe: claudeProbe,
			})
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
				if (agent.model) {
					envVars.ANTHROPIC_MODEL = agent.model
				}
				return { route: LLM_ROUTE_OAUTH, envVars, oauthSlot: oauthResult.slot }
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
			const envVars: Record<string, string> = { ANTHROPIC_API_KEY: wsAnthropic }
			if (agent.model) {
				envVars.ANTHROPIC_MODEL = agent.model
			}
			return { route: LLM_ROUTE_API_KEY, envVars }
		}
	}

	// 5. Maskin plan (pro/team/trial) — routed through Maskin's funded OR
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
