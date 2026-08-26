import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import type { SessionResultFailureReason } from '@maskin/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import { DEFAULT_PERIOD_LENGTH_MS, resolvePlanCapCents } from './billing-defaults'
import {
	type SubscriptionProbe,
	isClaudeFailoverEnabled,
	resolveClaudeCredentialsWithFailover,
} from './claude-failover'
import { type OAuthSlotKind, readSlots, resolveActiveSlot } from './claude-oauth-slots'
import { isEnterpriseWorkspace } from './enterprise-allowlist'
import { logger } from './logger'
import type { WorkspaceSettings } from './types'

const DEFAULT_CHAT_MODEL: Record<'anthropic' | 'openai' | 'ollama', string> = {
	anthropic: 'claude-haiku-4-5-20251001',
	openai: 'gpt-4o-mini',
	ollama: 'llama3',
}

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
 * own credentials — capped low via `MASKIN_TRIAL_HARD_CAP_USD_CENTS`.
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
 * Legacy fallback rate used only when a maskin_plan session never reported
 * its own `total_cost_usd` (e.g. a runtime whose CLI stream never emitted a
 * `result` event). Real cost — which reflects whatever model actually ran —
 * is always preferred; this exists so a missing report doesn't silently read
 * as $0 of usage.
 */
export const FALLBACK_TOKENS_PER_USD_CENT = 16_000

/**
 * Rounds a cents amount up to a whole cent after clearing IEEE754 dust.
 *
 * A bare `Math.ceil` on a float cents figure over-bills by a whole cent
 * whenever the multiplication lands a hair ABOVE an exact integer, which it
 * does for the most ordinary of prices: `10.05 * 100` is
 * `1005.0000000000001` in IEEE754, so `Math.ceil` returns 1006 and charges a
 * cent that was never spent. (`10.01` and `10.30` happen to land exactly, so
 * the bug is invisible on most values — it is not a rounding preference, it
 * is a defect that fires on an arbitrary subset of amounts.)
 *
 * Snapping to 6 decimal places first discards only that dust. Genuine
 * sub-cent usage still rounds up as intended: the sole producer of fractional
 * cents here is the token-rate fallback, whose smallest non-zero output is
 * `1 / FALLBACK_TOKENS_PER_USD_CENT` = 6.25e-5 cents — nearly two orders of
 * magnitude above the 1e-6 snapping threshold.
 */
export function ceilCents(cents: number): number {
	return Math.ceil(Number(cents.toFixed(6)))
}

/**
 * Sums actual dollar cost (in USD cents, rounded up) across the workspace's
 * maskin_plan sessions since `periodStart` (or all-time when undefined — used
 * for trial buckets that don't have a billing period yet). Prefers each
 * session's own reported `total_cost_usd` (populated from the CLI's own
 * reported cost, so it reflects whichever model actually ran) and falls back
 * to a flat token-rate estimate only for sessions that never reported one.
 * Tracking dollars instead of raw tokens is what lets different agents run
 * different models — each with a different $/token ratio — without the cap
 * silently over- or under-counting usage. The route filter is what makes
 * paid + trial usage cheap to query, even as the sessions table grows.
 */
export async function getWorkspacePlanUsdCentsUsage(
	// `Pick<…, 'select'>` (the `Queryable` shape from lib/workspace-capacity.ts)
	// rather than `Database` so callers can pass a `tx`. credit-billing.ts must
	// read this INSIDE its row-locked transaction — reading it outside would
	// let a concurrent debit change the cumulative total between the read and
	// the write.
	db: Pick<Database, 'select'>,
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
			totalCostUsd: sessions.totalCostUsd,
			inputTokens: sessions.inputTokens,
			outputTokens: sessions.outputTokens,
		})
		.from(sessions)
		.where(and(...conds))

	let totalCents = 0
	for (const row of rows) {
		const reportedUsd = row.totalCostUsd !== null ? Number(row.totalCostUsd) : Number.NaN
		if (Number.isFinite(reportedUsd) && reportedUsd > 0) {
			totalCents += reportedUsd * 100
			continue
		}
		const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
		totalCents += tokens / FALLBACK_TOKENS_PER_USD_CENT
	}
	// Round once on the aggregate, not per-row, so small per-session fractions
	// of a cent don't compound into meaningfully over-counted usage.
	return ceilCents(totalCents)
}

export type MaskinPlan = 'trial' | 'pro' | 'team'

interface PlanCapContext {
	plan: MaskinPlan
	/** USD cents. */
	used: number
	/** USD cents. */
	cap: number
	periodEnd: number | null
}

/**
 * Surfaces as HTTP 402 with `{ code: 'PLAN_CAP_EXCEEDED', plan, used, cap,
 * period_end }`. `used`/`cap` are USD cents (dollar cost, not token counts —
 * see `getWorkspacePlanUsdCentsUsage`). The frontend (Task dcfe3afe) reads
 * `period_end` to render a reset ETA and a typed upgrade CTA.
 */
export class PlanCapExceededError extends Error {
	readonly plan: MaskinPlan
	readonly used: number
	readonly cap: number
	readonly periodEnd: number | null

	constructor(ctx: PlanCapContext) {
		super(
			`${ctx.plan} plan cap exceeded: $${(ctx.used / 100).toFixed(2)} of $${(ctx.cap / 100).toFixed(2)} used this period.`,
		)
		this.name = 'PlanCapExceededError'
		this.plan = ctx.plan
		this.used = ctx.used
		this.cap = ctx.cap
		this.periodEnd = ctx.periodEnd
	}
}

/**
 * Returns the configured cap (USD cents) for a maskin_plan workspace.
 *
 * Falls back to the plan's documented default when Stripe hasn't written
 * `hard_cap_usd_cents` yet (delayed webhook, partial state after a webhook
 * failure). This previously returned `null` — no cap at all — for pro/team in
 * that window, so a paid workspace whose webhook was late could spend without
 * bound on Maskin's OpenRouter account. Failing *closed* onto the plan's own
 * published cap is the safe default: the customer keeps exactly the usage
 * they paid for, and `routes/billing.ts` already showed them that same number
 * via the shared resolver.
 */
function effectivePlanCap(plan: MaskinPlan, hardCapCents: number | undefined): number | null {
	if (typeof hardCapCents === 'number' && hardCapCents >= 0) return hardCapCents
	return resolvePlanCapCents(plan)
}

export function getWorkspacePlanCap(wsSettings: WorkspaceSettings): number | null {
	const billing = wsSettings.billing
	const plan = (billing?.plan ?? 'trial') as MaskinPlan | 'byollm'
	if (!MASKIN_PLAN_ROUTED_PLANS.has(plan)) return null
	return effectivePlanCap(plan as MaskinPlan, billing?.hard_cap_usd_cents ?? undefined)
}

function effectivePeriodEnd(
	periodStartMs: number | undefined,
	periodEndMs: number | undefined,
): number | null {
	if (typeof periodEndMs === 'number') return periodEndMs
	if (typeof periodStartMs === 'number') return periodStartMs + DEFAULT_PERIOD_LENGTH_MS
	return null
}

/** Spendable prepaid credit balance in cents, clamped to ≥0 defensively (writes are clamped too — see `lib/credit-billing.ts`). */
export function creditBalanceCents(billing: WorkspaceSettings['billing']): number {
	const raw = billing?.credit_balance_cents
	return typeof raw === 'number' && raw > 0 ? Math.floor(raw) : 0
}

/**
 * True once a workspace over its plan cap may keep running by drawing down
 * its prepaid credit balance instead of being hard-blocked. Trial never
 * qualifies — spending credits requires a paid plan with a card on file,
 * which `stripe_customer_id` and an `active` status together represent.
 * `past_due`/`canceled` intentionally still hard-block: a workspace that
 * can't be billed for its base plan shouldn't be allowed to draw down its
 * balance either.
 */
export function canUseCreditBalance(
	plan: MaskinPlan,
	billing: WorkspaceSettings['billing'],
): boolean {
	if (plan === 'trial') return false
	if (billing?.status !== 'active') return false
	if (!billing?.stripe_customer_id) return false
	return creditBalanceCents(billing) > 0
}

/**
 * Pre-flight check on the maskin_plan route. Called from `createSession` so the
 * HTTP caller gets a 402 *before* a session row is created (the v1 contract
 * with the over-cap banner). Also invoked at route-resolution time as
 * defense-in-depth against background calls that skipped the pre-check.
 *
 * No-op when the workspace is not on a maskin-plan-routed plan or when no cap
 * applies (e.g., paid plan pre-Stripe). Throws `PlanCapExceededError` when the
 * cap is exceeded and no prepaid credit balance is available for this
 * workspace (`canUseCreditBalance`) — otherwise lets the caller through;
 * the balance is actually debited separately at session-completion time
 * (`lib/credit-billing.ts`).
 */
export async function checkPlanCap(params: {
	db: Database
	workspaceId: string
	wsSettings: WorkspaceSettings
}): Promise<void> {
	const billing = params.wsSettings.billing
	const plan = (billing?.plan ?? 'trial') as MaskinPlan | 'byollm'
	if (!MASKIN_PLAN_ROUTED_PLANS.has(plan)) return
	if (await isEnterpriseWorkspace(params.db, params.workspaceId)) return

	const maskinPlan = plan as MaskinPlan
	const cap = effectivePlanCap(maskinPlan, billing?.hard_cap_usd_cents ?? undefined)
	if (cap === null) return

	// billing.period_start / period_end are Unix SECONDS (Stripe writes them
	// straight from current_period_start/end). Convert to ms before passing to
	// getWorkspacePlanUsdCentsUsage (which feeds new Date()) and effectivePeriodEnd.
	const periodStartMs =
		typeof billing?.period_start === 'number' ? billing.period_start * 1000 : undefined
	const periodEndMs =
		typeof billing?.period_end === 'number' ? billing.period_end * 1000 : undefined

	const used = await getWorkspacePlanUsdCentsUsage(params.db, params.workspaceId, periodStartMs)
	if (used < cap) return
	if (canUseCreditBalance(maskinPlan, billing)) return

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
/**
 * Is a Claude OAuth slot configured at all — i.e. does the slot that
 * `resolveClaudeCredentialsWithFailover` would actually read hold data?
 *
 * Existence only, never liveness. The flag branch mirrors that function
 * (claude-failover.ts): with failover ON the active slot is what counts, with
 * it OFF `active_slot` is ignored and `primary` is read directly, so that
 * turning the flag off as a kill-switch routes back to primary. Both the
 * pre-flight and the post-hoc "the OAuth route produced nothing" check below
 * go through here so the two can't drift apart.
 */
function hasConfiguredOAuthSlot(claudeOauth: unknown, env?: NodeJS.ProcessEnv): boolean {
	return isClaudeFailoverEnabled(env)
		? Boolean(resolveActiveSlot(claudeOauth))
		: Boolean(readSlots(claudeOauth).primary)
}

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
	/**
	 * Overrides `process.env` when reading the failover flag. Tests only —
	 * production callers omit it.
	 */
	env?: NodeJS.ProcessEnv
}): Promise<LlmRoutingResult | null> {
	const { db, workspaceId, actorId, wsSettings, agent, byollmAllowed, claudeProbe } = params

	/** Set when route #2 threw; folded into the error when nothing else resolves. */
	let oauthFailure: string | null = null

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

			// `resolveClaudeCredentialsWithFailover` reports an unusable
			// credential two ways: it throws, or it returns null (an expired
			// token behind a transient refresh failure, a probe that classified
			// as failover with no backup to fall to, a backup that failed its
			// own probe). Only the throw used to be recorded — so a workspace
			// with a connected-but-dead subscription and no other route fell
			// through this whole ladder silently and launched a container with
			// no ANTHROPIC_* env at all. That is the incident this file exists
			// to prevent, reached by its most common real-world shape.
			//
			// Guarded on a slot actually being configured: a null from a
			// workspace with no OAuth at all is simply "route not configured",
			// which is not a failure and must keep falling through.
			if (hasConfiguredOAuthSlot(wsSettings.claude_oauth, params.env)) {
				oauthFailure =
					'the connected Claude subscription did not yield a usable token (expired, revoked, or failed its health check)'
				logger.warn('Claude OAuth route resolved to no usable token', {
					workspaceId,
					actorId,
				})
			}
		} catch (err) {
			// The next route still takes over — a workspace with a custom endpoint
			// or an API key behind a dead subscription should keep working. But the
			// reason is no longer swallowed: when NO route resolves, this is the
			// only description of why, and losing it is what left session failures
			// reading as a generic "stuck in starting state".
			oauthFailure = err instanceof Error ? err.message : String(err)
			logger.warn('Claude OAuth route unavailable — falling through to next route', {
				workspaceId,
				actorId,
				error: oauthFailure,
			})
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

	if (oauthFailure) {
		// Every route was tried and the only one that had credentials at all
		// failed. Returning null here would launch a container with no
		// ANTHROPIC_* env at all, which dies inside the sandbox with a message
		// no one reads. Throw so the caller can put the real reason on the
		// session row.
		throw new LlmCredentialsUnavailableError(
			`Claude subscription credentials could not be resolved and no other LLM route is configured: ${oauthFailure}`,
		)
	}

	return null
}

/**
 * No usable LLM credential could be resolved for a session. Distinct from
 * `resolveLlmRoute` returning `null` (which means "this caller handles the
 * remaining non-anthropic providers itself"): this is terminal, and carries
 * the reason the credential that *was* configured didn't work.
 *
 * Surfaces on the session row as `result.failure_reason.reason_code =
 * 'not_logged_in'` so the UI and any agent reading `get_session` see why,
 * rather than the zombie reaper's generic stall message.
 */
export class LlmCredentialsUnavailableError extends Error {
	/** Operator-facing detail, persisted as `failure_reason.verbatim_output`. */
	readonly detail: string

	constructor(detail: string) {
		super(detail)
		this.name = 'LlmCredentialsUnavailableError'
		this.detail = detail
	}

	/** What the user and any agent reading `get_session` see. */
	static readonly humanMessage =
		'This session could not start because no working LLM credentials are connected for this workspace. Connect a Claude subscription in Settings → Keys, then start a new session.'

	toFailureReason(): SessionResultFailureReason {
		return {
			provider: 'maskin',
			reason_code: 'not_logged_in',
			human_message: LlmCredentialsUnavailableError.humanMessage,
			http_status: null,
			reset_at: null,
			verbatim_output: this.detail,
		}
	}
}

/**
 * Offline pre-flight for the LLM routes, run BEFORE a session is marked
 * `starting`.
 *
 * Deliberately makes no network call: it answers "is any route even
 * configured for this workspace", not "is the credential live". That keeps it
 * cheap enough to run on every launch, and it is the check that catches the
 * failure mode where a workspace has nothing to route to — previously that
 * session went to `starting`, got no env vars, and died in the sandbox (or,
 * when credential resolution hung, never died at all).
 *
 * Liveness is still the probe's job inside `resolveLlmRoute`; that path is now
 * bounded by CLAUDE_CREDENTIAL_TIMEOUT_MS and reports through
 * `LlmCredentialsUnavailableError`.
 *
 * Returns `null` when at least one route is configured, or a description of
 * what's missing when none is. Mirrors `resolveLlmRoute`'s priority order —
 * if you add a route there, add it here.
 */
export function preflightLlmCredentials(params: {
	wsSettings: WorkspaceSettings
	agent: AgentLlmConfig
	byollmAllowed: boolean
	env?: NodeJS.ProcessEnv
}): { humanMessage: string; detail: string } | null {
	const { wsSettings, agent, byollmAllowed } = params

	// 1. Agent-level override. A non-anthropic agent key is injected by the
	//    caller (session-manager sets OPENAI_API_KEY itself) rather than by
	//    resolveLlmRoute — but that injection is gated on `byollmAllowed` too,
	//    so an unentitled workspace has no route here regardless of provider.
	if (agent.apiKey && byollmAllowed) return null

	if (byollmAllowed) {
		// 2. Claude OAuth. Which slot counts depends on the failover flag, and
		//    it has to be read the same way `resolveClaudeCredentialsWithFailover`
		//    reads it. With the flag OFF that function ignores `active_slot` and
		//    goes straight to `primary` — deliberately, so disabling the flag as
		//    an incident kill-switch forces routing back to primary. Checking
		//    `active_slot` unconditionally here would refuse to launch a
		//    workspace left on `active_slot: 'backup'` after the switch was
		//    thrown, which is precisely the state the switch exists to recover.
		if (hasConfiguredOAuthSlot(wsSettings.claude_oauth, params.env)) return null

		// 3. Workspace custom_llm (same completeness bar as buildCustomLlmEnv).
		const custom = wsSettings.custom_llm
		if (
			custom?.enabled &&
			custom.base_url?.trim() &&
			custom.api_key?.trim() &&
			custom.model?.trim()
		) {
			return null
		}

		// 4. Workspace anthropic api key.
		if (wsSettings.llm_keys?.anthropic) return null

		// 4b. Workspace OpenAI key. Not part of resolveLlmRoute's ladder — it is
		//     injected directly by session-manager after that call returns — but
		//     it is a real route, so a workspace holding only this one must not
		//     be refused a launch.
		if (wsSettings.llm_keys?.openai) return null
	}

	// 5. Maskin plan.
	if (buildMaskinPlanEnv(wsSettings.billing, readFallbackConfig(params.env)) !== null) return null

	const detail = byollmAllowed
		? 'No Claude subscription, custom LLM endpoint, or Anthropic/OpenAI API key is configured for this workspace, and it is not on a Maskin-funded plan.'
		: 'This workspace is not on a Maskin-funded plan and is not entitled to bring its own LLM credentials.'
	return {
		humanMessage:
			'This session could not start because the workspace has no LLM credentials connected. Connect a Claude subscription in Settings → Keys, then start a new session.',
		detail,
	}
}

export interface ChatCredentials {
	provider: 'anthropic' | 'openai' | 'ollama'
	apiKey: string
	baseUrl?: string
	model: string
}

/**
 * Resolves credentials for a same-process, non-container LLM call (e.g. the
 * conversation-responder's "should I respond" relevance check via
 * `LLMAdapter.chat()`). This is a narrower sibling of `resolveLlmRoute`, not
 * a replacement — that function mints container-CLI env vars for the `claude`
 * binary (including Claude OAuth, which is not a portable bearer token
 * outside that CLI). Priority order mirrors resolveLlmRoute where the
 * concepts overlap:
 *
 *   1. Agent-level api_key (any provider — direct API calls aren't limited
 *      to anthropic the way container env injection is)
 *   2. Workspace custom_llm (OpenAI-compatible endpoint)
 *   3. Claude OAuth is intentionally skipped — see note above
 *   4. Workspace anthropic api_key (`settings.llm_keys.anthropic`)
 *   5. System fallback (MASKIN_FALLBACK_OPENROUTER_KEY), OpenRouter's
 *      OpenAI-compatible endpoint
 *
 * Returns null if no usable credential exists for this narrower, non-OAuth
 * path — this does NOT mean no credential exists at all: `resolveLlmRoute`
 * may still succeed via Claude OAuth once a real session launches. Since this
 * powers a best-effort relevance heuristic rather than a user-facing action,
 * callers should treat null as "the heuristic itself is unavailable," not as
 * "this agent has no credentials," and decide accordingly (e.g. fail open and
 * let the real session launch be the final word) rather than erroring loudly.
 */
export function resolveChatCredentials(params: {
	wsSettings: WorkspaceSettings
	agent: AgentLlmConfig
}): ChatCredentials | null {
	const { wsSettings, agent } = params

	if (agent.apiKey && agent.provider) {
		const provider = agent.provider as ChatCredentials['provider']
		if (provider === 'anthropic' || provider === 'openai' || provider === 'ollama') {
			return {
				provider,
				apiKey: agent.apiKey,
				model: agent.model?.trim() || DEFAULT_CHAT_MODEL[provider],
			}
		}
	}

	const custom = wsSettings.custom_llm
	if (
		custom?.enabled &&
		custom.base_url?.trim() &&
		custom.api_key?.trim() &&
		custom.model?.trim()
	) {
		return {
			provider: 'openai',
			apiKey: custom.api_key.trim(),
			baseUrl: custom.base_url.trim(),
			model: custom.small_fast_model?.trim() || custom.model.trim(),
		}
	}

	const wsAnthropic = wsSettings.llm_keys?.anthropic
	if (wsAnthropic) {
		return { provider: 'anthropic', apiKey: wsAnthropic, model: DEFAULT_CHAT_MODEL.anthropic }
	}

	const fallback = readFallbackConfig()
	if (!fallback.apiKey) return null
	return {
		provider: 'openai',
		apiKey: fallback.apiKey,
		// OpenRouter's OpenAI-compatible endpoint lives at /api/v1, distinct
		// from fallback.baseUrl's default ('/api') which targets the Claude
		// CLI's ANTHROPIC_BASE_URL — that shape expects the CLI to append its
		// own Anthropic-style path, ours needs the OpenAI-style /v1 prefix.
		baseUrl: 'https://openrouter.ai/api/v1',
		model: fallback.smallModel ?? fallback.model ?? DEFAULT_CHAT_MODEL.openai,
	}
}
