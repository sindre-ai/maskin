import {
	CLAUDE_SUBSCRIPTION_MODEL,
	LLM_ROUTE_AGENT,
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
	LLM_ROUTE_OAUTH,
	readFallbackConfig,
} from '../llm-routing'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export type AiGenerationOutcome = 'completed' | 'failed' | 'timeout' | 'user_stopped'

/**
 * Why a failed or timed-out session ended, from a fixed list. A code only, never
 * the provider's error text, so it cannot hold a key or customer content.
 */
export type AiGenerationFailureCode =
	| 'no_route'
	| 'key_rejected'
	| 'out_of_credit'
	| 'rate_limited'
	| 'container_start_failed'
	| 'timeout'
	| 'other'

const FAILURE_CODE_BY_REASON_CODE: Record<string, AiGenerationFailureCode> = {
	not_logged_in: 'no_route',
	invalid_api_key: 'key_rejected',
	oauth_revoked: 'key_rejected',
	oauth_expired: 'key_rejected',
	credit_balance_low: 'out_of_credit',
	insufficient_credits: 'out_of_credit',
	billing_error: 'out_of_credit',
	plan_cap_exceeded: 'out_of_credit',
	session_limit: 'rate_limited',
	weekly_limit: 'rate_limited',
	opus_limit: 'rate_limited',
	server_rate_limit: 'rate_limited',
	request_rejected_429: 'rate_limited',
	max_plan_rate_limit: 'rate_limited',
	rate_limit_error: 'rate_limited',
	agent_server_lost: 'container_start_failed',
	container_lost: 'container_start_failed',
	dispatch_failed: 'container_start_failed',
	startup_stalled: 'container_start_failed',
}

const FAILURE_CODE_BY_CLASSIFICATION: Record<string, AiGenerationFailureCode> = {
	credit_exhaustion: 'out_of_credit',
	plan_cap: 'out_of_credit',
	dispatch_failure: 'container_start_failed',
	startup_stalled: 'container_start_failed',
	sandbox_crash: 'container_start_failed',
	idle_timeout: 'timeout',
	wall_timeout: 'timeout',
}

/**
 * Maps a session's structured failure reason and terminal classification onto the
 * fixed code list. The reason code wins because it is the more specific signal;
 * the classification covers failures that carry no reason code. Null for sessions
 * that did not fail or time out.
 */
export function resolveFailureCode(
	outcome: AiGenerationOutcome,
	reasonCode: string | null | undefined,
	classification: string | null | undefined,
): AiGenerationFailureCode | null {
	if (outcome !== 'failed' && outcome !== 'timeout') return null
	return (
		(reasonCode ? FAILURE_CODE_BY_REASON_CODE[reasonCode] : undefined) ??
		(classification ? FAILURE_CODE_BY_CLASSIFICATION[classification] : undefined) ??
		(outcome === 'timeout' ? 'timeout' : 'other')
	)
}

export interface SessionAiGenerationProps {
	sessionId: string
	workspaceId: string
	actorId: string
	outcome: AiGenerationOutcome
	/** `result.failure_reason.reason_code` of the settled session, if it has one. */
	failureReasonCode?: string | null
	/** The settle's terminal classification, used when there is no reason code. */
	classification?: string | null
	/** `sessions.config` — only `llm_route` is read. */
	config: Record<string, unknown> | null
	/** `sessions.model_name` — null on every route except maskin_plan. */
	modelName: string | null
	/** Cumulative session totals, as persisted on the `sessions` row. */
	inputTokens: number | null
	outputTokens: number | null
	cacheReadTokens: number | null
	cacheCreationTokens: number | null
	/** `sessions.total_cost_usd` is a Postgres numeric, which Drizzle returns as a string. */
	costUsd: number | string | null
	/** `sessions.duration_ms` — the sum of the CLI's own per-turn duration_ms. */
	activeMs: number | null
	/** `sessions.started_at` — set once the container is up, so queue wait is excluded. */
	startedAt: Date | null
	completedAt: Date
}

function providerForRoute(route: string): string {
	if (route === LLM_ROUTE_MASKIN_PLAN) return 'openrouter'
	if (route === LLM_ROUTE_CUSTOM) return 'custom'
	if (route === LLM_ROUTE_OAUTH || route === LLM_ROUTE_API_KEY || route === LLM_ROUTE_AGENT) {
		return 'anthropic'
	}
	return 'unknown'
}

/**
 * Where `$ai_total_cost_usd` came from. Only maskin_plan is priced locally
 * from OpenRouter's table; every other route carries the CLI's own list-price
 * figure, which is an estimate and not what a subscription actually bills.
 */
function costBasisForRoute(route: string): string {
	return route === LLM_ROUTE_MASKIN_PLAN ? 'openrouter_price_table' : 'cli_list_price'
}

/**
 * `sessions.model_name` is only stamped on maskin_plan, so claude_oauth (and
 * the other routes) would otherwise reach PostHog with no model. Fall back to
 * what the route runs by default.
 *
 * The workspace_api_key, agent_api_key and custom routes have no default: the
 * model depends on the key and the agent, so naming one would present a guess
 * as fact. They get a labelled `unknown:<route>` instead, which keeps those
 * sessions apart from each other in PostHog's per-model cost split.
 */
function resolveModel(route: string, modelName: string | null): string {
	if (modelName) return modelName
	if (route === LLM_ROUTE_OAUTH) return CLAUDE_SUBSCRIPTION_MODEL
	if (route === LLM_ROUTE_MASKIN_PLAN) return readFallbackConfig().model ?? 'unknown'
	return route ? `unknown:${route}` : 'unknown'
}

function toFiniteNumber(value: number | string | null): number {
	const n = typeof value === 'string' ? Number(value) : value
	return n != null && Number.isFinite(n) ? n : 0
}

function secondsBetween(from: Date | null, to: Date): number | null {
	if (!from) return null
	return Math.max(0, (to.getTime() - from.getTime()) / 1000)
}

/**
 * Fires one `$ai_generation` per session at terminal state, so PostHog's AI
 * Observability tab shows a trace per session with token counts and USD cost.
 * The LLM calls happen inside the CLI in the sandbox, so per-call events are
 * not possible — this is the per-session total.
 *
 * Running time rides on the same event: `running_seconds` is wall-clock
 * (started_at to completed_at) and `active_seconds` is the CLI's own working
 * time. Interactive sessions can idle while running, so wall-clock is the
 * ceiling and active the floor.
 *
 * `$ai_input` / `$ai_output` are deliberately absent — prompts hold customer
 * data. Sessions that never launched (no started_at) used no tokens or hours
 * and are skipped, so per-session averages are not diluted by them.
 *
 * Best-effort: never throws, never blocks the terminal path.
 */
export async function trackSessionAiGeneration(p: SessionAiGenerationProps): Promise<void> {
	try {
		if (!p.startedAt) return
		const route = typeof p.config?.llm_route === 'string' ? p.config.llm_route : ''
		const runningSeconds = secondsBetween(p.startedAt, p.completedAt)
		const isError = p.outcome === 'failed' || p.outcome === 'timeout'
		await capturePosthogEvent('$ai_generation', p.workspaceId, {
			$ai_trace_id: p.sessionId,
			$ai_model: resolveModel(route, p.modelName),
			$ai_provider: providerForRoute(route),
			$ai_input_tokens: p.inputTokens ?? 0,
			$ai_output_tokens: p.outputTokens ?? 0,
			$ai_cache_read_input_tokens: p.cacheReadTokens ?? 0,
			$ai_cache_creation_input_tokens: p.cacheCreationTokens ?? 0,
			$ai_total_cost_usd: toFiniteNumber(p.costUsd),
			$ai_latency: runningSeconds,
			$ai_is_error: isError,
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			actor_id: p.actorId,
			llm_route: route || null,
			cost_basis: costBasisForRoute(route),
			outcome: p.outcome,
			failure_code: resolveFailureCode(p.outcome, p.failureReasonCode, p.classification),
			running_seconds: runningSeconds,
			active_seconds: p.activeMs == null ? null : p.activeMs / 1000,
			started_at: p.startedAt.toISOString(),
			completed_at: p.completedAt.toISOString(),
		})
	} catch (err) {
		logger.warn('Failed to emit $ai_generation', { sessionId: p.sessionId, error: String(err) })
	}
}
