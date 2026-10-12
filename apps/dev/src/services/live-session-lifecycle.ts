import type { Database } from '@maskin/db'
import { actors, liveSessions } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { type LiveEndedReason, trackLiveSessionEnded } from '../lib/analytics/live-events'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { captureLiveException } from '../lib/sentry-live'

/**
 * Terminal path for a live call. Every way a call can end (end route, socket
 * drop past its grace, idle sweeper, plan cap, shutdown) goes through
 * endLiveSession so the row, the cost, the audit event and the analytics event
 * cannot drift between paths.
 */

/** Idle window a call survives with no turn activity. */
export const LIVE_IDLE_TIMEOUT_MS = 15 * 60 * 1000
/** How long a dropped socket may stay away before the call is ended. */
export const LIVE_WS_GRACE_MS = 20_000

const LIVE_STATUSES = ['pending', 'active'] as const

const STATUS_FOR_REASON: Record<LiveEndedReason, 'ended' | 'timed_out' | 'errored'> = {
	user_hangup: 'ended',
	network_error: 'ended',
	server_stop: 'ended',
	plan_cap: 'ended',
	idle_timeout: 'timed_out',
	error: 'errored',
}

export type LiveSessionRow = typeof liveSessions.$inferSelect

export interface EndLiveSessionInput {
	id: string
	reason: LiveEndedReason
}

/**
 * Ends a live call exactly once. The UPDATE only matches rows still pending or
 * active, so an end request racing the sweeper (or a grace timer firing after
 * the user already hung up) resolves to a single winner; the loser gets null
 * and does nothing, keeping live_session_ended to one event per call.
 */
export async function endLiveSession(
	db: Database,
	input: EndLiveSessionInput,
): Promise<LiveSessionRow | null> {
	cancelLiveWsGrace(input.id)
	const [ended] = await db
		.update(liveSessions)
		.set({
			status: STATUS_FOR_REASON[input.reason],
			endedReason: input.reason,
			endedAt: new Date(),
		})
		.where(and(eq(liveSessions.id, input.id), inArray(liveSessions.status, [...LIVE_STATUSES])))
		.returning()
	if (!ended) return null

	const durationMs = (ended.endedAt ?? new Date()).getTime() - ended.startedAt.getTime()
	try {
		await recordEvent(db, {
			workspaceId: ended.workspaceId,
			actorId: ended.humanActorId,
			action: 'live_session_ended',
			entityType: 'live_session',
			entityId: ended.id,
			data: {
				reason: input.reason,
				duration_ms: durationMs,
				turn_count: ended.turnCount,
				total_cost_usd: Number(ended.totalCostUsd),
			},
		})
	} catch (err) {
		logger.warn('live_session_ended event write failed', {
			live_session_id: ended.id,
			error: err instanceof Error ? err.message : String(err),
		})
		captureLiveException(ended.id, err)
	}
	await emitEnded(db, ended, input.reason, durationMs)
	return ended
}

async function emitEnded(
	db: Database,
	s: LiveSessionRow,
	reason: LiveEndedReason,
	durationMs: number,
): Promise<void> {
	try {
		const [agent] = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, s.agentActorId))
			.limit(1)
		await trackLiveSessionEnded(s.humanActorId, {
			live_session_id: s.id,
			agent_id: s.agentActorId,
			agent_name: agent?.name ?? '',
			workspace_id: s.workspaceId,
			conversation_id: s.conversationId,
			input_mode: s.inputMode,
			llm_route: s.llmRoute,
			llm_model: s.llmModel,
			provider: s.provider,
			duration_ms: durationMs,
			ended_reason: reason,
			turn_count: s.turnCount,
			tool_calls_count: s.toolCallsCount,
			input_tokens: s.inputTokens,
			output_tokens: s.outputTokens,
			tts_characters: s.ttsCharacters,
			stt_seconds: s.sttSeconds,
			total_cost_usd: Number(s.totalCostUsd),
		})
	} catch (err) {
		// Analytics must never undo a call that has already been closed.
		logger.warn('live_session_ended capture failed', {
			live_session_id: s.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

export interface TurnUsageDelta {
	inputTokens: number
	outputTokens: number
	ttsCharacters: number
	sttSeconds: number
	llmCostUsd: number
	ttsCostUsd: number
	sttCostUsd: number
	toolCalls: number
}

/**
 * Adds one finished turn to the row and pushes the idle deadline out. Counters
 * live in the row rather than in memory, so a restart does not zero a call's
 * spend and the plan-cap aggregate always sees it.
 */
export async function recordLiveTurn(
	db: Database,
	id: string,
	d: TurnUsageDelta,
	now: Date = new Date(),
): Promise<void> {
	const total = d.llmCostUsd + d.ttsCostUsd + d.sttCostUsd
	await db
		.update(liveSessions)
		.set({
			turnCount: sql`${liveSessions.turnCount} + 1`,
			toolCallsCount: sql`${liveSessions.toolCallsCount} + ${d.toolCalls}`,
			inputTokens: sql`${liveSessions.inputTokens} + ${d.inputTokens}`,
			outputTokens: sql`${liveSessions.outputTokens} + ${d.outputTokens}`,
			ttsCharacters: sql`${liveSessions.ttsCharacters} + ${d.ttsCharacters}`,
			sttSeconds: sql`${liveSessions.sttSeconds} + ${d.sttSeconds}`,
			llmCostUsd: sql`${liveSessions.llmCostUsd} + ${d.llmCostUsd.toFixed(6)}::numeric`,
			ttsCostUsd: sql`${liveSessions.ttsCostUsd} + ${d.ttsCostUsd.toFixed(6)}::numeric`,
			sttCostUsd: sql`${liveSessions.sttCostUsd} + ${d.sttCostUsd.toFixed(6)}::numeric`,
			totalCostUsd: sql`${liveSessions.totalCostUsd} + ${total.toFixed(6)}::numeric`,
			lastActivityAt: now,
			timeoutAt: new Date(now.getTime() + LIVE_IDLE_TIMEOUT_MS),
		})
		.where(and(eq(liveSessions.id, id), inArray(liveSessions.status, [...LIVE_STATUSES])))
}

/** Marks a pending call active once its socket is up. No-op for any other status. */
export async function activateLiveSession(db: Database, id: string): Promise<void> {
	await db
		.update(liveSessions)
		.set({ status: 'active', lastActivityAt: new Date() })
		.where(and(eq(liveSessions.id, id), eq(liveSessions.status, 'pending')))
}

// ── Socket-drop grace ────────────────────────────────────────────────

const graceTimers = new Map<string, NodeJS.Timeout>()

/**
 * Called when a call's socket closes without the call having ended. If the
 * client does not reconnect within the grace, the call ends as network_error.
 * A reconnect or any other terminal path cancels it. In-process on purpose:
 * one apps/dev process owns every live socket today.
 */
export function startLiveWsGrace(
	db: Database,
	liveSessionId: string,
	graceMs: number = LIVE_WS_GRACE_MS,
): void {
	cancelLiveWsGrace(liveSessionId)
	const timer = setTimeout(() => {
		graceTimers.delete(liveSessionId)
		endLiveSession(db, { id: liveSessionId, reason: 'network_error' }).catch((err) => {
			logger.error('Live WS-drop grace end failed', {
				live_session_id: liveSessionId,
				error: err instanceof Error ? err.message : String(err),
			})
			captureLiveException(liveSessionId, err)
		})
	}, graceMs)
	timer.unref()
	graceTimers.set(liveSessionId, timer)
}

export function cancelLiveWsGrace(liveSessionId: string): void {
	const timer = graceTimers.get(liveSessionId)
	if (timer) {
		clearTimeout(timer)
		graceTimers.delete(liveSessionId)
	}
}

// ── Daily minute cap ─────────────────────────────────────────────────

function startOfUtcDay(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** Minutes of live a workspace has used since 00:00 UTC; a live call counts up to now. */
export async function getLiveMinutesUsedToday(
	db: Database,
	workspaceId: string,
	now: Date = new Date(),
): Promise<number> {
	const [row] = await db
		.select({
			seconds: sql<string>`coalesce(sum(extract(epoch from (coalesce(${liveSessions.endedAt}, now()) - ${liveSessions.startedAt}))), 0)`,
		})
		.from(liveSessions)
		.where(
			and(
				eq(liveSessions.workspaceId, workspaceId),
				sql`${liveSessions.startedAt} >= ${startOfUtcDay(now).toISOString()}::timestamptz`,
			),
		)
	const seconds = Number(row?.seconds ?? 0)
	return Number.isFinite(seconds) ? seconds / 60 : 0
}

/** Seconds until the daily window resets (next 00:00 UTC), at least 1. */
export function secondsUntilLiveCapResets(now: Date = new Date()): number {
	const next = startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000
	return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}
